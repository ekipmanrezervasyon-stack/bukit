import PDFDocument from "pdfkit";
import { PDFDocument as LibPdfDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ReservationKind = "equipment" | "studio";

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

const formatDateRange = (startAt: string, endAt: string): string => {
  const s = new Date(startAt);
  const e = new Date(endAt);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${startAt} → ${endAt}`;
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fmt(s)} → ${fmt(e)}`;
};

export const generateCheckoutPdf = async (ctx: CheckoutContext): Promise<string | null> => {
  if (ctx.kind === "equipment") {
    const byTemplate = await generateFromTemplate(ctx);
    if (byTemplate) return byTemplate;
  }
  // Üretilecek form çok küçük, data URL tarayıcılar için yeterli.
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const chunks: Buffer[] = [];

  return await new Promise<string>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", (err: Error) => reject(err));
    doc.on("end", () => {
      const buf = Buffer.concat(chunks);
      const base64 = buf.toString("base64");
      resolve(`data:application/pdf;base64,${base64}`);
    });

    const isStudio = ctx.kind === "studio";

    // Header
    doc.fontSize(14).font("Helvetica-Bold").text("FACULTY OF COMMUNICATION", { align: "left" });
    doc.moveDown(0.15);
    doc.fontSize(13).font("Helvetica-Bold").text(isStudio ? "STUDIO HANDOVER FORM" : "EQUIPMENT HANDOVER FORM", {
      align: "left"
    });
    doc.moveDown(0.6);

    doc
      .fontSize(10)
      .font("Helvetica")
      .text(`Reservation ID: ${ctx.reservationId}`)
      .moveDown(0.2)
      .text(`Student Name: ${ctx.studentName || "-"}`)
      .moveDown(0.2)
      .text(`Student Email: ${ctx.studentEmail || "-"}`)
      .moveDown(0.2)
      .text(`Date Range: ${formatDateRange(ctx.startAt, ctx.endAt)}`);

    if (isStudio) {
      const sCtx = ctx as StudioCheckoutContext;
      doc
        .moveDown(0.4)
        .text(`Studio: ${sCtx.studioName || "-"}`)
        .moveDown(0.2)
        .text(`Handover Note: ${sCtx.handoverNote || "-"}`);
    }

    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(11).text(isStudio ? "Notes" : "Equipment Condition");
    doc.moveDown(0.4);

    if (!isStudio) {
      const eCtx = ctx as EquipmentCheckoutContext;
      const items = eCtx.items || [];

      // Tablo başlıkları
      const startX = doc.x;
      const colWidths = [90, 190, 100, 100]; // ID, Name, Condition Out, Condition In

      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .text("Equipment ID", startX, doc.y, { width: colWidths[0] })
        .text("Equipment Name", startX + colWidths[0], doc.y, { width: colWidths[1] })
        .text("Condition Out", startX + colWidths[0] + colWidths[1], doc.y, { width: colWidths[2] })
        .text("Condition In", startX + colWidths[0] + colWidths[1] + colWidths[2], doc.y, { width: colWidths[3] });

      doc.moveDown(0.6);
      doc.font("Helvetica").fontSize(9);

      if (items.length) {
        items.forEach((item) => {
          const y = doc.y;
          doc
            .text(item.code || "-", startX, y, { width: colWidths[0] })
            .text(item.name || "-", startX + colWidths[0], y, { width: colWidths[1] })
            .text(item.conditionOut || "-", startX + colWidths[0] + colWidths[1], y, {
              width: colWidths[2]
            })
            .text("", startX + colWidths[0] + colWidths[1] + colWidths[2], y, {
              width: colWidths[3]
            });
          doc.moveDown(0.4);
        });
      } else {
        doc.text("-", startX, doc.y);
      }
    } else {
      doc
        .font("Helvetica")
        .fontSize(10)
        .text(ctx.kind === "studio" ? (ctx as StudioCheckoutContext).handoverNote || "-" : "-", {
          width: 480
        });
    }

    // Terms & Conditions (TR + EN) – simplified from original form
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(10).text("II. ŞARTLAR VE KOŞULLAR");
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(9);
    doc.text(
      "1. Sorumluluk: Öğrenci, yukarıda listelenen tüm ekipmanlar için tam hukuki ve mali sorumluluğu üstlenir."
    );
    doc.moveDown(0.1);
    doc.text(
      "2. Kayıp ve Hasar: Hırsızlık, kayıp veya yanlış kullanım ve ihmalden kaynaklanan teknik hasar durumunda; öğrenci, ekipmanın tam yenileme/ikame bedelini ödemekle yükümlüdür."
    );
    doc.moveDown(0.1);
    doc.text(
      "3. İade Koşulları: Tüm ekipmanlar belirtilen son teslim tarihinde iade edilmelidir. Bu kurala uyulmaması, öğrencinin kısa ya da uzun süreli hak mahrumiyetine sebep olur. (Detaylar: booking.bilgi.edu.tr)."
    );

    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(10).text("II. TERMS & CONDITIONS");
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(9);
    doc.text(
      "1. Liability: The student assumes full legal and financial responsibility for the equipment listed above."
    );
    doc.moveDown(0.1);
    doc.text(
      "2. Loss & Damage: In case of theft, loss, or technical damage due to misuse or negligence, the student is liable for the full replacement cost."
    );
    doc.moveDown(0.1);
    doc.text(
      "3. All gear must be returned by the specified deadline. Missing the deadline may result in temporary or long-term suspension of booking privileges. (Details: booking.bilgi.edu.tr)."
    );

    // Signature area
    doc.moveDown(1);
    const sigStartX = doc.x;
    const midX = sigStartX + 260;

    doc.font("Helvetica-Bold").fontSize(9).text("RECEIVED BY (STUDENT)", sigStartX, doc.y, {
      width: 240
    });
    doc.text("RETURNED BY (STUDENT)", midX, doc.y, { width: 240 });
    doc.moveDown(0.5);

    doc
      .font("Helvetica")
      .fontSize(8)
      .text(`${ctx.studentName || "-"} / ${formatDateRange(ctx.startAt, ctx.endAt).split("→")[0].trim()}`, sigStartX, doc.y, {
        width: 240
      });
    doc.text(
      `${ctx.studentName || "-"} / ${formatDateRange(ctx.startAt, ctx.endAt).split("→")[1]?.trim() || "-"}`,
      midX,
      doc.y,
      { width: 240 }
    );
    doc.moveDown(1);

    doc
      .font("Helvetica")
      .fontSize(8)
      .text("Wet Signature", sigStartX, doc.y, { width: 240 })
      .text("Wet Signature", midX, doc.y, { width: 240 });

    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(9).text("Authorized Staff Signature:", sigStartX, doc.y, {
      width: 240
    });
    doc.text("HANDOVER: ____________________", sigStartX, doc.y + 14, { width: 240 });
    doc.text("RETURN: ____________________", midX, doc.y + 14, { width: 240 });

    doc.end();
  });
};

const getTemplatePath = (): string => {
  const fromEnv = String(process.env.PDF_EQUIPMENT_TEMPLATE_PATH || "").trim();
  return fromEnv || DEFAULT_TEMPLATE_PATH;
};

const toDataUrl = (bytes: Uint8Array): string => {
  const base64 = Buffer.from(bytes).toString("base64");
  return `data:application/pdf;base64,${base64}`;
};

const safeText = (v: string): string => String(v || "").replace(/\s+/g, " ").trim();

const loadOverlayFont = async (pdfDoc: LibPdfDocument) => {
  const fromEnv = String(process.env.PDF_OVERLAY_FONT_PATH || "").trim();
  const fontPath = fromEnv || DEFAULT_UNICODE_FONT_PATH;
  try {
    const fontBytes = await fs.readFile(fontPath);
    return await pdfDoc.embedFont(fontBytes);
  } catch {
    return await pdfDoc.embedFont(StandardFonts.Helvetica);
  }
};

const generateFromTemplate = async (ctx: EquipmentCheckoutContext): Promise<string | null> => {
  const templatePath = getTemplatePath();
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(templatePath);
  } catch {
    return null;
  }

  const pdfDoc = await LibPdfDocument.load(bytes);
  pdfDoc.registerFontkit(fontkit);
  const page = pdfDoc.getPages()[0];
  if (!page) return null;
  const font = await loadOverlayFont(pdfDoc);
  const draw = (text: string, x: number, y: number, size = 10) =>
    page.drawText(safeText(text || "-"), { x, y, size, font, color: rgb(0, 0, 0) });

  // Header fields
  draw(ctx.startAt || "-", 128, 768, 9);
  draw(ctx.endAt || "-", 335, 768, 9);
  draw(ctx.studentName || "-", 100, 742, 10);
  draw(ctx.reservationId || "-", 280, 742, 9);

  // Equipment 4-grid rows
  // x: id=48, name=150, condOut=365, condIn=470
  let y = 708;
  for (const item of ctx.items.slice(0, 14)) {
    draw(item.code || "-", 48, y, 9);
    draw(item.name || "-", 150, y, 9);
    draw(item.conditionOut || "-", 365, y, 9);
    draw("", 470, y, 9); // Condition In intentionally empty for manual fill
    y -= 16;
  }

  // Signature name/date helpers
  draw(`${ctx.studentName || "-"} / ${ctx.startAt || "-"}`, 50, 176, 8);
  draw(`${ctx.studentName || "-"} / ${ctx.endAt || "-"}`, 324, 176, 8);

  const out = await pdfDoc.save();
  return toDataUrl(out);
};

