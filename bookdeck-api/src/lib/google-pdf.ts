import { google } from "googleapis";
import { env } from "../config/env.js";

type ReservationKind = "equipment" | "studio";

type EquipmentCheckoutContext = {
  kind: "equipment";
  reservationId: string;
  studentName: string;
  studentEmail: string;
  startAt: string;
  endAt: string;
  items: { name: string; code: string }[];
};

type StudioCheckoutContext = {
  kind: "studio";
  reservationId: string;
  studentName: string;
  studentEmail: string;
  startAt: string;
  endAt: string;
  studioName: string;
  handoverNote: string;
};

type CheckoutContext = EquipmentCheckoutContext | StudioCheckoutContext;

const hasDriveConfig = (): boolean => {
  const hasJson = Boolean(String(env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim());
  const hasSplitCreds = Boolean(
    String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim() &&
      String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").trim()
  );
  return Boolean(
    (hasJson || hasSplitCreds) &&
      (env.GOOGLE_EQUIPMENT_FORM_DOC_ID || env.GOOGLE_STUDIO_FORM_DOC_ID)
  );
};

const getDriveAuth = () => {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let clientEmail = String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  let privateKey = String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "");

  // Support base64-encoded private key
  const privateKeyB64 = String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_B64 || "").trim();
  if (privateKeyB64 && !privateKey) {
    privateKey = Buffer.from(privateKeyB64, "base64").toString("utf-8");
  }

  if (raw) {
    const creds = JSON.parse(raw) as { client_email?: string; private_key?: string };
    clientEmail = String(creds.client_email || clientEmail || "").trim();
    privateKey = String(creds.private_key || privateKey || "");
  }

  if (privateKey.includes("\\n")) {
    // Many env providers store PEM line breaks as escaped \n.
    privateKey = privateKey.replace(/\\n/g, "\n");
  }
  if (!clientEmail || !privateKey) {
    throw new Error(
      "Missing Google service account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY."
    );
  }
  const scopes = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents"
  ];
  return new google.auth.JWT(clientEmail, undefined, privateKey, scopes);
};

export const generateCheckoutPdf = async (ctx: CheckoutContext): Promise<string | null> => {
  if (!hasDriveConfig()) return null;

  const auth = getDriveAuth();
  await auth.authorize();
  const drive = google.drive({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });

  const templateId =
    ctx.kind === "studio" ? env.GOOGLE_STUDIO_FORM_DOC_ID : env.GOOGLE_EQUIPMENT_FORM_DOC_ID;
  if (!templateId) return null;

  const fileName =
    (ctx.kind === "studio" ? "Studio_" : "Equipment_") +
    (ctx.studentName || "User") +
    "_" +
    new Date().toISOString().slice(0, 10);

  const copyRes = await drive.files.copy({
    fileId: templateId,
    requestBody: {
      name: fileName,
      parents: env.GOOGLE_PDF_FOLDER_ID ? [env.GOOGLE_PDF_FOLDER_ID] : undefined
    }
  });
  const docId = copyRes.data.id;
  if (!docId) throw new Error("Failed to copy template document");

  const replacements: Record<string, string> = {
    Student_Name: ctx.studentName || "-",
    Student_Email: ctx.studentEmail || "-",
    Reservation_Id: ctx.reservationId,
    Start_Date: ctx.startAt,
    End_Date: ctx.endAt
  };

  if (ctx.kind === "studio") {
    replacements.Studio_Name = ctx.studioName || "-";
    replacements.Handover_Note = ctx.handoverNote || "";
  } else {
    const list = ctx.items
      .map((it) => `${it.name} (${it.code || ""})`.trim())
      .join("\n");
    replacements.Equipment_List = list || "-";
  }

  const requests: Array<{
    replaceAllText: {
      containsText: { text: string; matchCase: boolean };
      replaceText: string;
    };
  }> = [];

  for (const [key, val] of Object.entries(replacements)) {
    requests.push({
      replaceAllText: {
        containsText: {
          text: `{{${key}}}`,
          matchCase: false
        },
        replaceText: val
      }
    });
  }

  if (requests.length) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests }
    });
  }

  const pdfUrl = `https://docs.google.com/document/d/${docId}/export?format=pdf`;
  return pdfUrl;
};

