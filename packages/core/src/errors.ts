export class HttpError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
export function insist(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new HttpError(status, code, message);
}
export function fileName(value: string) {
  const name = value.normalize('NFC');
  insist(name.length > 0 && name.isWellFormed() && Buffer.byteLength(name, 'utf8') <= 255 && !/[\\/:*?"<>|\x00-\x1f\x7f]/.test(name)
    && !/[. ]$/.test(name) && !['.', '..'].includes(name), 400, 'INVALID_NAME', 'Nom de fichier ou de dossier invalide.');
  return name;
}
