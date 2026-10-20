import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

async function parsePdf(data: Buffer): Promise<string> {
  const parser = new PDFParse({ data });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm'];

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i).toLowerCase() : '';
}

export function isSupported(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(filename));
}

/** Extract plain text from an uploaded file. Runs inside workers, never on the API thread. */
export async function extractText(filename: string, data: Buffer): Promise<string> {
  const ext = extensionOf(filename);
  switch (ext) {
    case '.pdf':
      return parsePdf(data);
    case '.docx':
      return (await mammoth.extractRawText({ buffer: data })).value;
    case '.html':
    case '.htm':
      return data
        .toString('utf8')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    default:
      return data.toString('utf8');
  }
}
