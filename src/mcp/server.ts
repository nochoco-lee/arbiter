import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { queueManager } from '../queue';
import { leaseManager } from '../state/lease';
import { ContextManager } from '../context';

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
    switch (request.params.name) {
        case "request_lease": {
            const token = await queueManager.enqueue({
                resource: request.params.arguments.resource,
                duration_seconds: request.params.arguments.duration_seconds
            });
            return {
                content: [{ type: "text", text: `Lease Granted. Token: ${token}` }]
            };
        }
        case "yield_lease": {
            const success = await leaseManager.yieldLease({
                token: request.params.arguments.token,
                reason: request.params.arguments.reason
            });
            queueManager.pump('*');
            return {
                content: [{ type: "text", text: success ? "Lease yielded." : "Failed to yield." }]
            };
        }
        case "get_context": {
            const ctx = ContextManager.loadLastContext(request.params.arguments.resource);
            return {
                content: [{ type: "text", text: ctx ? JSON.stringify(ctx, null, 2) : "No context found." }]
            };
        }
        default:
            throw new Error(`Unknown tool: ${request.params.name}`);
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Arbiter MCP Server running on stdio");
}

if (require.main === module) {
    main().catch(e => {
        console.error(e);
        process.exit(1);
    });
}
