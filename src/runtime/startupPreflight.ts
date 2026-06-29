import net from 'node:net';

export async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => {
      reject(new Error(`Port preflight failed for ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`));
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(closeError => {
        if (closeError) reject(closeError);
        else resolve();
      });
    });
  });
}
