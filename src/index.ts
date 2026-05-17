/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

/* 
Example of using Hono framework in Cloudflare Workers
*/

import { Hono } from 'hono';
import { uploadFileToNotion } from './notion/upload';
import { Client } from '@notionhq/client';

type Env = {
    Bindings: {
        WEBHOOK_SECRET: string;
        NOTION_API_KEY: string;
        NOTION_ROOT_PAGE_ID: string;
    };
};

const app = new Hono<{ Bindings: Env['Bindings'] }>()


// Notion rate limit: 3 req/s (we stay at 2 to be safe).
const MAX_REQUESTS_PER_SECOND = 2;
const MIN_REQUEST_INTERVAL_MS = 1000 / MAX_REQUESTS_PER_SECOND;
let lastRequestTime = 0;

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}


async function ensureRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - elapsed);
    if (wait > 0) {
        await sleep(wait);
    }
    lastRequestTime = Date.now();
}

export async function getDatasourceId(databaseId: string, notion: Client) {

    const response = await notion.databases.retrieve({ database_id: databaseId! });

    if ("data_sources" in response) {
        const dataSourceIds = response.data_sources;
        const firstDataSourceId = dataSourceIds[0];
        if (!firstDataSourceId) {
            return null; // No data sources found
        }
        const dataSource = await notion.dataSources.retrieve({ data_source_id: firstDataSourceId.id });
        if (!dataSource) {
            return null; // Data source not found
        }
        return dataSource.id;
    }
}

async function fingerprint(value: string | undefined): Promise<string | null> {
    if (!value) return null;

    const data = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const bytes = [...new Uint8Array(hash)];

    return bytes
        .slice(0, 8)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function secretShape(value: string | undefined) {
    return {
        present: Boolean(value),
        length: value?.length ?? 0,
        trimmedLength: value?.trim().length ?? 0,
        startsWithSpace: value?.startsWith(" ") ?? false,
        endsWithSpace: value?.endsWith(" ") ?? false,
        startsWithQuote: value?.startsWith('"') ?? false,
        endsWithQuote: value?.endsWith('"') ?? false,
    };
}



app.post('/', async (c) => {
    const secret = c.req.header("x-webhook-secret")

    const receivedSecretRaw = c.req.header("x-webhook-secret");
    const expectedSecretRaw = c.env.WEBHOOK_SECRET;

    const receivedSecret = receivedSecretRaw?.trim();
    const expectedSecret = expectedSecretRaw?.trim();

    console.log("Webhook secret debug", {
        received: secretShape(receivedSecretRaw),
        expected: secretShape(expectedSecretRaw),
        receivedFingerprint: await fingerprint(receivedSecret),
        expectedFingerprint: await fingerprint(expectedSecret),
        matchesRaw: receivedSecretRaw === expectedSecretRaw,
        matchesTrimmed: receivedSecret === expectedSecret,
    });

    if (!expectedSecret) {
        return c.json(
            {
                ok: false,
                error: "WEBHOOK_SECRET not configured",
            },
            500
        );
    }

    if (!receivedSecret || receivedSecret !== expectedSecret) {
        return c.json(
            {
                ok: false,
                error: "Unauthorized",
            },
            401
        );
    }

    if (!secret || secret !== c.env.WEBHOOK_SECRET) {
        return c.json({ ok: false, error: "Unauthorized" }, 401)
    }

    const notion = new Client({ auth: c.env.NOTION_API_KEY });

    let files: NotionFileFromWebhook[] = []
    let targetPageId: string | undefined = undefined;
    let sourcePageId: string | undefined = undefined;

    const body = await c.req.json();

    sourcePageId = body.data.id;

    if (!sourcePageId) {
        return c.json(
            {
                ok: false,
                reason: "Source page ID not found in webhook payload",
            },
            400
        );
    }

    files = body.data.properties['Arquivos e mídia'].files as NotionFileFromWebhook[];

    if (files.length > 0) {
        targetPageId = body?.data?.properties['📝 Materiais de Estudo']?.relation[0]?.id;
    }
    if (!targetPageId) {
        // Fallback logic for getting target page ID if not found in the expected property
        // 2. Fallback: o destino sabe a fonte

        if (!c.env.NOTION_ROOT_PAGE_ID) {
            return c.json(
                {
                    ok: false,
                    reason: "Materials database page ID misconfigured"
                }, 400
            )
        }

        // Get datasource
        const datasourceId = await getDatasourceId(c.env.NOTION_ROOT_PAGE_ID, notion);

        if (!datasourceId) {
            return c.json({
                ok: false, reason: "Could not retrieve datasource"

            }, 400)
        }

        const materialPageOfGivenForm = await notion.dataSources.query({
            data_source_id: datasourceId,
            filter: {
                property: "Formulário",
                relation: {
                    contains: sourcePageId
                }
            },
            sorts: [
                {
                    timestamp: "created_time",
                    direction: "descending"
                }
            ],
            page_size: 1
        })

        targetPageId = materialPageOfGivenForm.results[0]?.id;
    }

    if (!targetPageId) {
        return c.json(
            {
                ok: false,
                reason: "Target page ID not found in webhook payload",
            },
            400
        );
    }

    for (const f of files) {

        const uploaded = await uploadFileToNotion(f, ensureRateLimit);

        if (!uploaded) {
            continue;
        }

        try {
            await notion.pages.update({
                page_id: targetPageId,
                properties: {
                    "Arquivos e mídia": {
                        type: "files",
                        files: [{
                            type: "file_upload",
                            file_upload: {
                                id: uploaded.fileUploadId
                            },
                            name: uploaded.filename
                        }]
                    }
                }
            });



        } catch (e) {
            console.log(e)
        } finally {
        }

    }

    return c.text('Hello Cloudflare Workers!')
})

export default app

// export default {
// 	async fetch(request, env, ctx): Promise<Response> {
// 		return new Response("Hello World!");
// 	},
// } satisfies ExportedHandler<Env>;
