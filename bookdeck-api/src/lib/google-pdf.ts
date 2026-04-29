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
  projectName?: string;
  usageType?: string;
  handoverNote: string;
};

type CheckoutContext = EquipmentCheckoutContext | StudioCheckoutContext;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EQUIPMENT_TEMPLATE_PATH = resolve(__dirname, "../../assets/Equipment Handover Form.pdf");
const DEFAULT_STUDIO_TEMPLATE_PATH = resolve(__dirname, "../../assets/Studio Usage Form.pdf");
const DEFAULT_UNICODE_FONT_PATH = resolve(
  __dirname,
  "../../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf"
);

const parseStoredDateParts = (raw: string): { year: string; month: string; day: string; hour: string; minute: string } | null => {
  const m = String(raw || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (!m) return null;
  return { year: m[1], month: m[2], day: m[3], hour: m[4], minute: m[5] };
};

const formatDate = (iso: string): string => {
  const raw = String(iso || "").trim();
  const parts = parseStoredDateParts(raw);
  if (parts) return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
};

const formatDdMmYyyyDashHm = (iso: string): string => {
  const raw = String(iso || "").trim();
  const parts = parseStoredDateParts(raw);
  if (parts) return `${parts.day}.${parts.month}.${parts.year} - ${parts.hour}:${parts.minute}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} - ${hh}:${mi}`;
};

const formatKeyPickedUpStamp = (dateInput: Date): string => {
  const d = new Date(dateInput.getTime());
  if (Number.isNaN(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("tr-TR", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(d);
    const map: Record<string, string> = {};
    parts.forEach((p) => {
      map[p.type] = p.value;
    });
    return `${map.day || "00"} / ${map.month || "00"} / ${map.year || "0000"} - ${map.hour || "00"} : ${map.minute || "00"}`;
  } catch {
    return "";
  }
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

const generateEquipmentFromTemplate = async (ctx: EquipmentCheckoutContext): Promise<string | null> => {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(DEFAULT_EQUIPMENT_TEMPLATE_PATH);
  } catch {
    return null;
  }

  const templateDoc = await LibPdfDocument.load(bytes);
  const templatePage = templateDoc.getPages()[0];
  if (!templatePage) return null;

  const pdfDoc = await LibPdfDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await loadOverlayFont(pdfDoc);

  const rowsPerPage = 9;
  const totalItems = Array.isArray(ctx.items) ? ctx.items.length : 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / rowsPerPage));

  const drawText = (page: import("pdf-lib").PDFPage, text: string, x: number, y: number, size = 9) =>
    page.drawText(safeText(text), { x, y, size, font, color: rgb(0, 0, 0) });

  // Tablo satırları
  // Başlık y=595, ilk satır ~575'ten başlıyor, her satır ~22px aralıklı
  // NAME kolonu kullanıcı isteğine göre ~4 karakter sola kaydırıldı.
  const tableStartY = 575;
  const rowHeight = 24;
  const nameColX = 171; // 187 -> 171 (yaklaşık 4 karakter sola)

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
    const [copied] = await pdfDoc.copyPages(templateDoc, [0]);
    const page = pdfDoc.addPage(copied);

    // Header alanları — her sayfada tekrar edilir.
    drawText(page, formatDate(ctx.startAt), 160, 722);
    drawText(page, formatDate(ctx.endAt), 160, 698);
    drawText(page, clip(ctx.studentName, 40), 160, 675);
    drawText(page, clip(ctx.reservationId, 30), 160, 651, 8);
    drawText(page, clip(ctx.projectExplanation || "-", 60), 160, 628, 8);

    const start = pageIndex * rowsPerPage;
    const end = Math.min(start + rowsPerPage, totalItems);
    for (let i = start; i < end; i++) {
      const item = ctx.items[i];
      const row = i - start;
      const y = tableStartY - row * rowHeight;
      drawText(page, clip(item.code || "-", 14), 62, y, 8);
      drawText(page, clip(item.name || "-", 28), nameColX, y, 8);
      drawText(page, clip(item.conditionOut || "-", 14), 329, y, 8);
      // Condition In kasıtlı boş bırakılıyor (elle doldurulacak)
    }

    // İmzalar son sayfada bırakılır.
    if (pageIndex === totalPages - 1) {
      drawText(page, `${clip(ctx.studentName, 22)} / ${formatDate(ctx.startAt)}`, 80, 140, 8);
      drawText(page, `${clip(ctx.studentName, 22)} / ${formatDate(ctx.endAt)}`, 305, 140, 8);
    }
  }

  return toDataUrl(await pdfDoc.save());
};

const generateStudioFromTemplate = async (ctx: StudioCheckoutContext): Promise<string | null> => {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(DEFAULT_STUDIO_TEMPLATE_PATH);
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

  const bookingNameId = `${clip(ctx.studentName, 26)} / ${clip(ctx.reservationId, 20)}`;
  const usageLine = `${clip(formatDdMmYyyyDashHm(ctx.startAt), 22)} / ${clip(formatDdMmYyyyDashHm(ctx.endAt), 22)}`;
  const usageTypeLine = clip(ctx.usageType || "TEK SEFERLIK / ONE TIME", 56);

  // Top table rows (reference file has the grid slightly higher).
  // Move all values ~48px up to land exactly inside their labeled rows.
  draw(bookingNameId, 229, 692, 9); // Booking Name / ID
  draw(clip(ctx.studioName || "-", 56), 229, 669, 9); // Studio
  draw(clip(ctx.projectName || "-", 56), 229, 645, 9); // Project
  draw(clip(ctx.handoverNote || "-", 56).toUpperCase(), 229, 621, 9); // Condition
  // Override "Repeat" label in template and replace with "Usage Type".
  page.drawRectangle({ x: 66, y: 596, width: 128, height: 13, color: rgb(1, 1, 1) });
  draw("Usage Type:", 66, 597, 9);
  draw(usageTypeLine, 229, 597, 9);
  draw(clip(usageLine, 56), 229, 573, 9); // Usage

  // Key picked up timestamp: print time of PDF generation (GMT+3 display format DD.MM / HH:MM).
  const printedAt = formatKeyPickedUpStamp(new Date());
  if (printedAt) draw(printedAt, 355, 430, 9);

  // "Depo Sorumlusu / Authorized Staff" alanı bilinçli olarak boş bırakılır.
  // Top "Reserved By" signature area: only name.
  draw(clip(ctx.studentName, 24).toUpperCase(), 305, 343, 8.5);

  return toDataUrl(await pdfDoc.save());
};

export const generateCheckoutPdf = async (ctx: CheckoutContext): Promise<string | null> => {
  if (ctx.kind === "equipment") {
    const result = await generateEquipmentFromTemplate(ctx);
    if (result) return result;
  } else {
    const result = await generateStudioFromTemplate(ctx);
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
