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

app.post('/', async (c) => {
    // Await for the Notion internals create the bond between the original page and the copy. 
    // Otherwise we will get TypeError: Cannot read properties of undefined (reading 'id')

    let files: NotionFileFromWebhook[] = []
    let newPageId: string | undefined = undefined;


    await sleep(1000);
    const body = await c.req.json();
    files = body.data.properties['Arquivos e mídia'].files as NotionFileFromWebhook[];
    if (files.length > 0) {
        newPageId = body?.data?.properties['📝 Materiais de Estudo']?.relation[0]?.id;
    }


    if (!newPageId) {
        return c.json({ ok: false, error: "Missing source page id" }, 400);
    }

    for (const f of files) {

        const uploaded = await uploadFileToNotion(f, ensureRateLimit);

        if (!uploaded) {
            continue;
        }


        try {
            await notion.pages.update({
                page_id: newPageId,
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
