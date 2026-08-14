export type ClosableClient = { connect(): Promise<void>; end(): Promise<void> };

export async function withClosableClient<T>(client: ClosableClient, callback: () => Promise<T>): Promise<T> {
  await client.connect();
  try { return await callback(); } finally { await client.end(); }
}
