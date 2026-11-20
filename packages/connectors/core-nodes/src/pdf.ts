import PDFDocument from 'pdfkit';

export interface TextPdfInput {
  title?: string;
  lines: string[];
}

/** Render a simple text document (optional title heading + body lines) as a PDF. */
export function generateTextPdf(input: TextPdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      compress: false,
      info: {
        Title: input.title ?? 'Document',
        Subject: input.title ?? 'Document',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (input.title) {
      doc.fontSize(20).text(input.title);
      doc.moveDown();
    }
    doc.fontSize(12);
    for (const line of input.lines) {
      doc.text(line);
    }
    doc.end();
  });
}
