import {
  indexDocument,
  isRagConfigured,
  listDocuments,
} from "@/lib/server/rag";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".html", ".pdf"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

async function extractText(file: File): Promise<string> {
  const extension = extensionOf(file.name);
  if (extension === ".pdf") {
    const { extractText: extractPdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const result = await extractPdfText(pdf, { mergePages: true });
    return result.text;
  }
  return file.text();
}

function workspaceFrom(value: FormDataEntryValue | null): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) {
    throw new Error("A valid workspace is required.");
  }
  return value;
}

export async function GET(request: Request): Promise<Response> {
  const workspaceId = new URL(request.url).searchParams.get("workspace_id");
  if (!workspaceId || !/^[a-zA-Z0-9-]{16,80}$/.test(workspaceId)) {
    return Response.json({ error: "A valid workspace is required." }, { status: 400 });
  }
  try {
    return Response.json({
      available: true,
      storage: isRagConfigured() ? "supabase" : "local",
      documents: await listDocuments(workspaceId),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not load documents." },
      { status: 503 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let workspaceId: string;
  let file: File;
  try {
    const form = await request.formData();
    workspaceId = workspaceFrom(form.get("workspace_id"));
    const uploadedFile = form.get("file");
    if (!(uploadedFile instanceof File)) throw new Error("Choose a document to upload.");
    file = uploadedFile;
    if (file.size > MAX_FILE_BYTES) throw new Error("Documents must be smaller than 10 MB.");
    if (!SUPPORTED_EXTENSIONS.has(extensionOf(file.name))) {
      throw new Error("Supported formats are PDF, TXT, MD, CSV, JSON, and HTML.");
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not read this upload." },
      { status: 400 },
    );
  }

  try {
    const chunks = await indexDocument(workspaceId, file.name.slice(0, 160), await extractText(file));
    return Response.json({
      document: file.name,
      chunks,
      storage: isRagConfigured() ? "supabase" : "local",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not index this document." },
      { status: 503 },
    );
  }
}
