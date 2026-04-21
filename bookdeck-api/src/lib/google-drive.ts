import { Readable } from "node:stream";
import { google } from "googleapis";
import { env } from "../config/env.js";

type DriveUploadPayload = {
  fileName: string;
  mimeType: string;
  base64: string;
  folderId?: string;
};

const DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive"];

const parseServiceAccountCredentials = (): { client_email: string; private_key: string } | null => {
  const rawJson = String(env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const clientEmail = String(parsed.client_email || "").trim();
      const privateKey = String(parsed.private_key || "").replace(/\\n/g, "\n").trim();
      if (clientEmail && privateKey) return { client_email: clientEmail, private_key: privateKey };
    } catch {
      // fallback to split env vars
    }
  }
  const clientEmail = String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  const privateKey = String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if (!clientEmail || !privateKey) return null;
  return { client_email: clientEmail, private_key: privateKey };
};

const createDriveClient = () => {
  const credentials = parseServiceAccountCredentials();
  if (!credentials) return null;
  const auth = new google.auth.GoogleAuth({ credentials, scopes: DRIVE_SCOPE });
  return google.drive({ version: "v3", auth });
};

export const uploadPdfToDrive = async (
  payload: DriveUploadPayload
): Promise<{ fileId: string; url: string } | null> => {
  const folderId = String(payload.folderId || env.GOOGLE_PDF_FOLDER_ID || "").trim();
  if (!folderId) return null;
  const drive = createDriveClient();
  if (!drive) return null;
  const rawB64 = String(payload.base64 || "").replace(/\s+/g, "");
  if (!rawB64) return null;
  const buffer = Buffer.from(rawB64, "base64");
  const createRes = await drive.files.create({
    requestBody: {
      name: String(payload.fileName || "checkout.pdf"),
      mimeType: String(payload.mimeType || "application/pdf"),
      parents: [folderId]
    },
    media: {
      mimeType: String(payload.mimeType || "application/pdf"),
      body: Readable.from(buffer)
    },
    fields: "id,webViewLink,webContentLink"
  });
  const fileId = String(createRes.data.id || "").trim();
  if (!fileId) return null;
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { type: "anyone", role: "reader" },
      fields: "id"
    });
  } catch {
    // permission may be blocked by workspace policy; keep private link
  }
  const meta = await drive.files.get({
    fileId,
    fields: "id,webViewLink,webContentLink"
  });
  const url = String(meta.data.webViewLink || meta.data.webContentLink || `https://drive.google.com/file/d/${fileId}/view`).trim();
  return { fileId, url };
};

