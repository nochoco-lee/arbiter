import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BROKER_URL = process.env.ARBITER_URL || "http://localhost:38401";

const server = new Server(
    {
        name: "arbiter-mcp",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {}
        }
    }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "request_lease",
                description: "Request an ARBITER lease for a specific device resource",
                inputSchema: {
                    type: "object",
                    properties: {
                        resource: { type: "string" },
                        duration_seconds: { type: "number" }
                    },
                    required: ["resource"]
                }
            },
            {
                name: "yield_lease",
                description: "Yield the current lease and provide context",
                inputSchema: {
                    type: "object",
                    properties: {
                        token: { type: "string" },
                        reason: { type: "string" }
                    },
                    required: ["token"]
                }
            },
            {
                name: "get_context",
                description: "Get context schema dump from previous lease holder",
                inputSchema: {
                    type: "object",
                    properties: {
                        resource: { type: "string" }
                    },
                    required: ["resource"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    try {
        switch (request.params.name) {
            case "request_lease": {
                const response = await fetch(`${BROKER_URL}/request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        resource: request.params.arguments.resource,
                        duration_seconds: request.params.arguments.duration_seconds
                    })
                });
                const data = await response.json();
                
                if (response.status === 200) {
                    return {
                        content: [{ type: "text", text: `Lease Granted. Token: ${data.token}` }]
                    };
                } else if (response.status === 202) {
                    return {
                        content: [{ type: "text", text: `Lease Reserved (Enqueued). Ticket: ${data.token}. Estimated wait: ${data.estimated_wait_seconds}s` }]
                    };
                } else {
                    return {
                        content: [{ type: "text", text: `Failed to request lease: ${data.error || 'Unknown error'}` }],
                        isError: true
                    };
                }
            }
            case "yield_lease": {
                const response = await fetch(`${BROKER_URL}/yield`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: request.params.arguments.token,
                        reason: request.params.arguments.reason
                    })
                });
                const data = await response.json();
                return {
                    content: [{ type: "text", text: data.success ? "Lease yielded." : "Failed to yield." }]
                };
            }
            case "get_context": {
                const response = await fetch(`${BROKER_URL}/api/context?resource=${encodeURIComponent(request.params.arguments.resource)}`);
                if (response.status === 200) {
                    const ctx = await response.json();
                    return {
                        content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }]
                    };
                } else {
                    return {
                        content: [{ type: "text", text: "No context found." }]
                    };
                }
            }
            default:
                throw new Error(`Unknown tool: ${request.params.name}`);
        }
    } catch (error: any) {
        if (error.cause?.code === 'ECONNREFUSED' || error.message?.includes('fetch failed')) {
            return {
                content: [{ 
                    type: "text", 
                    text: `Error: Could not connect to Arbiter Broker at ${BROKER_URL}. Please ensure the broker is running by executing 'arbiter start' in a separate terminal.` 
                }],
                isError: true
            };
        }
        throw error;
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Arbiter MCP Server running on stdio (Bridge Mode)");
}

if (require.main === module) {
    main().catch(e => {
        console.error(e);
        process.exit(1);
    });
}
