import PDFDocument from "pdfkit";

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
  // Üretilecek form çok küçük, data URL tarayıcılar için yeterli.
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const chunks: Buffer[] = [];

  return await new Promise<string>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", (err) => reject(err));
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

