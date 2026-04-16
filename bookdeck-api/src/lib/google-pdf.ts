import PDFDocument from "pdfkit";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type EquipmentCheckoutContext = {
  kind: "equipment";
  phase?: "checkout" | "return";
  reservationId: string;
  studentName: string;
  studentEmail: string;
  startAt: string;
  endAt: string;
  projectExplanation?: string;
  items: { name: string; code: string; conditionOut: string; conditionIn?: string }[];
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
const DEJAVU_REGULAR = resolve(__dirname, "../../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const DEJAVU_BOLD = resolve(__dirname, "../../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
};

const safeText = (v: string): string => String(v || "").replace(/\s+/g, " ").trim();

const embedDejaVu = async (doc: PDFKit.PDFDocument): Promise<{ body: string; bold: string }> => {
  try {
    const [reg, bol] = await Promise.all([fs.readFile(DEJAVU_REGULAR), fs.readFile(DEJAVU_BOLD)]);
    doc.registerFont("BdSans", reg);
    doc.registerFont("BdSansBold", bol);
    return { body: "BdSans", bold: "BdSansBold" };
  } catch {
    return { body: "Helvetica", bold: "Helvetica-Bold" };
  }
};

export const generateCheckoutPdf = async (ctx: CheckoutContext): Promise<string | null> => {
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: "BookDeck" } });
  const chunks: Buffer[] = [];
  const fonts = await embedDejaVu(doc);

  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => {
      const b64 = Buffer.concat(chunks).toString("base64");
      resolve(`data:application/pdf;base64,${b64}`);
    });

    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    if (ctx.kind === "studio") {
      doc.font(fonts.bold).fontSize(15).text("İletişim Fakültesi — Stüdyo teslim formu", { width: w });
      doc.moveDown(0.4);
      doc.font(fonts.body).fontSize(10)
        .text(`Öğrenci: ${safeText(ctx.studentName)}`, { width: w })
        .text(`E-posta: ${safeText(ctx.studentEmail)}`, { width: w })
        .text(`Stüdyo: ${safeText(ctx.studioName)}`, { width: w })
        .text(`Başlangıç: ${formatDate(ctx.startAt)}`, { width: w })
        .text(`Bitiş: ${formatDate(ctx.endAt)}`, { width: w });
      if (ctx.handoverNote) {
        doc.moveDown(0.3);
        doc.font(fonts.bold).text("Teslim / durum notu:", { continued: true });
        doc.font(fonts.body).text(` ${safeText(ctx.handoverNote)}`, { width: w });
      }
      doc.moveDown(0.5);
      doc.font(fonts.body).fontSize(8).fillColor("#555555").text(`Ref: ${safeText(ctx.reservationId)}`, { width: w });
      doc.fillColor("#000000");
    } else {
      const isReturn = ctx.phase === "return";
      const title = isReturn ? "Ekipman iade kaydı" : "Ekipman teslim formu";
      doc.font(fonts.bold).fontSize(15).text(`İletişim Fakültesi — ${title}`, { width: w });
      doc.moveDown(0.4);
      doc.font(fonts.body).fontSize(10)
        .text(`Öğrenci: ${safeText(ctx.studentName)}`, { width: w })
        .text(`E-posta: ${safeText(ctx.studentEmail)}`, { width: w })
        .text(`Çıkış: ${formatDate(ctx.startAt)}`, { width: w })
        .text(`İade: ${formatDate(ctx.endAt)}`, { width: w });
      if (!isReturn && ctx.projectExplanation) {
        doc.moveDown(0.2);
        doc.font(fonts.bold).text("Proje / açıklama:", { continued: true });
        doc.font(fonts.body).text(` ${safeText(ctx.projectExplanation)}`, { width: w });
      }
      doc.fillColor("#000000");
      doc.moveDown(0.6);
      doc.font(fonts.bold).fontSize(10).text(isReturn ? "Kalemler (çıkış → iade)" : "Kalemler", { width: w });
      doc.moveDown(0.25);
      doc.font(fonts.body).fontSize(9);
      const items = ctx.items || [];
      if (!items.length) {
        doc.text("—", { width: w });
      } else {
        items.slice(0, 24).forEach((it, idx) => {
          doc.font(fonts.body).text(`${idx + 1}. ${safeText(it.code)}  ${safeText(it.name)}`, { width: w });
          doc.text(`   Çıkış durumu: ${safeText(it.conditionOut || "—")}`, { width: w });
          if (isReturn) doc.text(`   İade durumu: ${safeText(it.conditionIn || "—")}`, { width: w });
          doc.moveDown(0.15);
        });
      }
      doc.moveDown(0.3);
      doc.font(fonts.body).fontSize(8).fillColor("#555555").text(`Rezervasyon: ${safeText(ctx.reservationId)}`, { width: w });
      doc.fillColor("#000000");
    }

    doc.end();
  });
};
