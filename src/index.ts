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

const app = new Hono()
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const materiasDatabasePageId = process.env.NOTION_ROOT_PAGE_ID;


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

export async function getDatasourceId() {
    const databaseId = process.env.NOTION_ROOT_PAGE_ID;

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

app.post('/', async (c) => {
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

        if (!materiasDatabasePageId) {
            return c.json(
                {
                    ok: false,
                    reason: "Materials database page ID misconfigured"
                }, 400
            )
        }

        // Get datasource
        const datasourceId = getDatasourceId();

        if (!datasourceId) {
            return c.json({
                ok: false, reason: "Could not retrieve datasource"

            }, 400)
        }

        const materialPageOfGivenForm = await notion.dataSources.query({
            data_source_id: materiasDatabasePageId,
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
