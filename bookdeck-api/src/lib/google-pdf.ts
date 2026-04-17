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
  projectExplanation?: string;
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
  const tz = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(d);
  return tz;
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

  // Header alanları — etiket sonrasına yaz
  // Check Out Date: y=720, etiket "Check Out Date:" ~115px → değer 160'tan başlasın
  draw(formatDate(ctx.startAt), 160, 722);

  // Return Date: y=696
  draw(formatDate(ctx.endAt), 160, 698);

  // Profile Name: y=673
  draw(clip(ctx.studentName, 40), 160, 675);

  // Profile ID: y=649
  draw(clip(ctx.reservationId, 30), 160, 651, 8);

  // Project Explanation: diğer alanlarla aynı yatay başlangıç hizası
  draw(clip(ctx.projectExplanation || "-", 60), 160, 628, 8);

  // Tablo satırları
  // Başlık y=595, ilk satır ~575'ten başlıyor, her satır ~22px aralıklı
  // Sütun x koordinatları: ID=60, NAME=185, CONDITION_OUT=327, CONDITION_IN=460
  const tableStartY = 575;
  const rowHeight = 24;

  for (let i = 0; i < Math.min(ctx.items.length, 9); i++) {
    const item = ctx.items[i];
    const y = tableStartY - i * rowHeight;
    draw(clip(item.code || "-", 14),          62,  y, 8);
    draw(clip(item.name || "-", 28),          187, y, 8);
    draw(clip(item.conditionOut || "-", 14),  329, y, 8);
    // Condition In kasıtlı boş bırakılıyor (elle doldurulacak)
  }

  // İmza tablosu — RECEIVED/RETURNED altı y=166, tablo içi ~140
  draw(`${clip(ctx.studentName, 22)} / ${formatDate(ctx.startAt)}`, 80,  140, 8);
  draw(`${clip(ctx.studentName, 22)} / ${formatDate(ctx.endAt)}`,   305, 140, 8);

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
