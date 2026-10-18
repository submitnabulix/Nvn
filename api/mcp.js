// Minimal MCP server (Streamable HTTP, plain JSON responses) for Vercel.
// Put this file at api/mcp.js in your GitHub repo.

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }

  const { id, method, params } = body;

  // Notifications (no id) get an empty 202 response.
  if (id === undefined || id === null) return res.status(202).end();

  const ok = (result) => res.status(200).json({ jsonrpc: '2.0', id, result });
  const fail = (code, message) =>
    res.status(200).json({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: (params && params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'nvn-verse', version: '1.0.0' },
      });

    case 'ping':
      return ok({});

    case 'tools/list':
      return ok({
        tools: [
          {
            name: 'ping_nvn',
            description: 'Test tool: confirms the NVN Verse MCP server is working.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

    case 'tools/call':
      if (params && params.name === 'ping_nvn') {
        return ok({ content: [{ type: 'text', text: 'NVN Verse MCP is working!' }] });
      }
      return fail(-32602, 'Unknown tool');

    default:
      return fail(-32601, 'Method not found');
  }
};
