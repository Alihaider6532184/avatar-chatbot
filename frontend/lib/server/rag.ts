import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EMBEDDING_DIMENSIONS = 768;
const MAX_CHUNK_CHARACTERS = 2_400;
const CHUNK_OVERLAP_CHARACTERS = 300;

let client: SupabaseClient | null = null;
let localWriteQueue: Promise<void> = Promise.resolve();

interface LocalDocumentChunk {
  workspaceId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
}

function localStorePath(): string {
  return path.join(process.cwd(), ".local-data", "document-chunks.json");
}

async function readLocalChunks(): Promise<LocalDocumentChunk[]> {
  try {
    const payload = JSON.parse(await readFile(localStorePath(), "utf8")) as unknown;
    return Array.isArray(payload) ? payload as LocalDocumentChunk[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("The local document store could not be read.");
  }
}

async function writeLocalChunks(chunks: LocalDocumentChunk[]): Promise<void> {
  const filePath = localStorePath();
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, JSON.stringify(chunks), "utf8");
  await rename(temporaryPath, filePath);
}

async function updateLocalChunks(
  update: (chunks: LocalDocumentChunk[]) => LocalDocumentChunk[],
): Promise<void> {
  const operation = localWriteQueue.then(async () => {
    await writeLocalChunks(update(await readLocalChunks()));
  });
  localWriteQueue = operation.catch(() => undefined);
  await operation;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function isRagConfigured(): boolean {
  return Boolean(
    process.env.RAG_SUPABASE_URL
    && process.env.RAG_SUPABASE_SERVICE_ROLE_KEY
    && process.env.GEMINI_API_KEY,
  );
}

function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(
      requiredEnvironment("RAG_SUPABASE_URL"),
      requiredEnvironment("RAG_SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return client;
}

async function embedText(text: string, title: string): Promise<number[]> {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": requiredEnvironment("GEMINI_API_KEY"),
      },
      body: JSON.stringify({
        content: { parts: [{ text: `title: ${title} | text: ${text}` }] },
        output_dimensionality: EMBEDDING_DIMENSIONS,
      }),
    },
  );
  if (!response.ok) throw new Error("The embedding service could not process this document.");
  const payload = await response.json() as { embedding?: { values?: number[] } };
  const values = payload.embedding?.values;
  if (!values || values.length !== EMBEDDING_DIMENSIONS) throw new Error("The embedding service returned an invalid vector.");
  return values;
}

export function chunkDocument(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + MAX_CHUNK_CHARACTERS);
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARACTERS);
  }
  return chunks;
}

async function indexLocalDocument(
  workspaceId: string,
  documentName: string,
  chunks: string[],
): Promise<number> {
  await updateLocalChunks((existing) => [
    ...existing.filter(
      (chunk) => chunk.workspaceId !== workspaceId || chunk.documentName !== documentName,
    ),
    ...chunks.map((content, chunkIndex) => ({
      workspaceId,
      documentName,
      chunkIndex,
      content,
    })),
  ]);
  return chunks.length;
}

async function indexRemoteDocument(
  workspaceId: string,
  documentName: string,
  chunks: string[],
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { error: deleteError } = await supabase
    .from("document_chunks")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("document_name", documentName);
  if (deleteError) throw new Error("The document store is not ready. Run the RAG database schema first.");

  const rows = [];
  for (let index = 0; index < chunks.length; index += 1) {
    rows.push({
      workspace_id: workspaceId,
      document_name: documentName,
      chunk_index: index,
      content: chunks[index],
      embedding: `[${(await embedText(chunks[index], documentName)).join(",")}]`,
    });
  }
  const { error } = await supabase.from("document_chunks").insert(rows);
  if (error) throw new Error("The document could not be stored in the vector database.");
  return rows.length;
}

export async function indexDocument(workspaceId: string, documentName: string, text: string): Promise<number> {
  const chunks = chunkDocument(text);
  if (!chunks.length) throw new Error("The document did not contain readable text.");
  return isRagConfigured()
    ? indexRemoteDocument(workspaceId, documentName, chunks)
    : indexLocalDocument(workspaceId, documentName, chunks);
}

export async function listDocuments(workspaceId: string): Promise<string[]> {
  if (!isRagConfigured()) {
    return [...new Set(
      (await readLocalChunks())
        .filter((chunk) => chunk.workspaceId === workspaceId)
        .map((chunk) => chunk.documentName),
    )].sort();
  }
  const { data, error } = await getSupabaseAdmin()
    .from("document_chunks")
    .select("document_name")
    .eq("workspace_id", workspaceId)
    .order("document_name");
  if (error) throw new Error("The document store is not ready.");
  return [...new Set((data ?? []).map((row) => row.document_name as string))];
}

function queryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g)
      ?.filter((term) => !new Set([
        "and", "are", "but", "for", "from", "has", "have", "how", "not",
        "the", "this", "that", "was", "what", "when", "where", "which", "who",
        "why", "with", "you", "your",
      ]).has(term)) ?? [],
  )];
}

async function retrieveLocalContext(workspaceId: string, query: string): Promise<string> {
  const terms = queryTerms(query);
  if (!terms.length) return "";
  return (await readLocalChunks())
    .filter((chunk) => chunk.workspaceId === workspaceId)
    .map((chunk) => {
      const content = chunk.content.toLowerCase();
      const title = chunk.documentName.toLowerCase();
      const score = terms.reduce((total, term) => (
        total
        + (content.includes(term) ? 1 : 0)
        + (title.includes(term) ? 2 : 0)
      ), 0);
      return { chunk, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(({ chunk }) => `[${chunk.documentName}] ${chunk.content}`)
    .join("\n\n");
}

export async function retrieveContext(workspaceId: string, query: string): Promise<string> {
  if (!isRagConfigured()) return retrieveLocalContext(workspaceId, query);
  const embedding = await embedText(query, "user question");
  const { data, error } = await getSupabaseAdmin().rpc("match_document_chunks", {
    query_embedding: `[${embedding.join(",")}]`,
    match_workspace_id: workspaceId,
    match_count: 5,
  });
  if (error) throw new Error("The document search failed.");
  return (data ?? [])
    .filter((row: { similarity?: number }) => (row.similarity ?? 0) >= 0.35)
    .map((row: { document_name: string; content: string }) => `[${row.document_name}] ${row.content}`)
    .join("\n\n");
}
