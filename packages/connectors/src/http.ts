export interface SafeHttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}
export interface SafeHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}
export interface SafeHttp {
  request(req: SafeHttpRequest, signal: AbortSignal): Promise<SafeHttpResponse>;
}
