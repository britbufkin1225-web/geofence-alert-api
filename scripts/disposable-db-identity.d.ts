export function verifyDisposableDatabase(url: string | undefined): string;
export function validateUrl(url: string | undefined): string;
export function disposableUrl(port?: string): string;
export function validateContainer(
  container: unknown,
  requireHealthy?: boolean,
): void;
