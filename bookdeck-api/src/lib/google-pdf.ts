import PDFDocument from "pdfkit";
import { PDFDocument as LibPdfDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type EquipmentCheckoutContext = {
  kind: "equipment";
  reservationId: string;
  studentName: string;
  studentEmail: string;
  startAt: string;
  endAt: string;
  items: { name: string; code: string; conditionOut: string }[];
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_PATH = resolve(__dirname, "../../assets/Equipment Handover Form.pdf");
const DEFAULT_UNICODE_FONT_PATH = resolve(
  __dirname,
  "../../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf"
);

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const safeText = (v: string): string => String(v || "").replace(/\s+/g, " ").trim();
const clip = (v: string, n: number) => {
  const t = safeText(v || "-");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const toDataUrl = (bytes: Uint8Array): string =>
  `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`;

const loadOverlayFont = async (pdfDoc: LibPdfDocument) => {
  try {
    const fontBytes = await fs.readFile(DEFAULT_UNICODE_FONT_PATH);
    return await pdfDoc.embedFont(fontBytes);
  } catch {
    return await pdfDoc.embedFont(StandardFonts.Helvetica);
  }
};

const generateFromTemplate = async (ctx: EquipmentCheckoutContext): Promise<string | null> => {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(DEFAULT_TEMPLATE_PATH);
  } catch {
    return null;
  }

  const pdfDoc = await LibPdfDocument.load(bytes);
  pdfDoc.registerFontkit(fontkit);
  const page = pdfDoc.getPages()[0];
  if (!page) return null;
  const font = await loadOverlayFont(pdfDoc);

  const draw = (text: string, x: number, y: number, size = 9) =>
    page.drawText(safeText(text), { x, y, size, font, color: rgb(0, 0, 0) });
  const white = (x: number, y: number, w: number, h: number) =>
    page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1) });

  // CHECK-OUT DATE: x=72, y=666 → değer sağında ~185'ten başlıyor
  draw(formatDate(ctx.startAt), 185, 668);

  // RETURN DATE: x=302 civarı → değer ~390'dan başlıyor
  draw(formatDate(ctx.endAt), 390, 668);

  // Profile Name: y=639 → değer ~185'ten
  draw(clip(ctx.studentName, 30), 185, 641);

  // Profile ID: y=639 → değer ~390'dan
  draw(clip(ctx.reservationId, 24), 390, 641, 8);

  // Equipment List: y=613, bir satır aşağısından başla
  let y = 595;
  for (const item of ctx.items.slice(0, 10)) {
    draw(clip(item.code || "-", 12),  72,  y, 8);
    draw(clip(item.name || "-", 38),  160, y, 8);
    draw(clip(item.conditionOut || "-", 14), 400, y, 8);
    y -= 16;
    if (y < 410) break;
  }

  // İmza tablosu içi — RECEIVED BY altı (y~155) ve RETURNED BY altı
  draw(`${clip(ctx.studentName, 22)} / ${formatDate(ctx.startAt)}`, 80,  148, 8);
  draw(`${clip(ctx.studentName, 22)} / ${formatDate(ctx.endAt)}`,   305, 148, 8);

  return toDataUrl(await pdfDoc.save());
};

export const generateCheckoutPdf = async (ctx: CheckoutContext): Promise<string | null> => {
  if (ctx.kind === "equipment") {
    const result = await generateFromTemplate(ctx);
    if (result) return result;
  }

  // Fallback: pdfkit ile basit form
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => {
      const b64 = Buffer.concat(chunks).toString("base64");
      resolve(`data:application/pdf;base64,${b64}`);
    });
    doc.fontSize(14).font("Helvetica-Bold").text("FACULTY OF COMMUNICATION");
    doc.fontSize(13).text(ctx.kind === "studio" ? "STUDIO HANDOVER FORM" : "EQUIPMENT HANDOVER FORM");
    doc.moveDown();
    doc.fontSize(10).font("Helvetica")
      .text(`Student: ${ctx.studentName}`)
      .text(`Email: ${ctx.studentEmail}`)
      .text(`Check-out: ${formatDate(ctx.startAt)}`)
      .text(`Return: ${formatDate(ctx.endAt)}`);
    doc.end();
  });
};
