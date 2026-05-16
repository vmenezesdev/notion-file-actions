import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

// TIP: Does not work with Notion temporary S3 URLs.
// external_url likely performs a HEAD request, while the signed URL only supports GET.
// Replace with direct download + Notion file_upload.    
// const createResponse = await fetch(FILE_UPLOAD_ENDPOINT, {
//     method: "POST",
//     headers: { ...notionHeaders, "Content-Type": "application/json" },
//     body: JSON.stringify({ filename, content_type: contentType, mode: "external_url", external_url: url }),
// });


const NOTION_API_VERSION = "2022-06-28";
const FILE_UPLOAD_ENDPOINT = "https://api.notion.com/v1/file_uploads";
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

const MIME_TYPES: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    xml: "application/xml",
    zip: "application/zip",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
};

function getMimeType(filename: string): string {
    const ext = extname(filename).replace(".", "").toLowerCase();
    return MIME_TYPES[ext] ?? "application/octet-stream";
}

export interface FileUploadResult {
    fileUploadId: string;
    filename: string;
}

/**
 * Uploads a local file to Notion using the three-step Direct Upload API:
 * 1. POST /v1/file_uploads          — create upload object, receive upload_url + id
 * 2. POST {upload_url}              — send multipart/form-data with file content
 * 3. Return fileUploadId            — caller attaches it to a page/block property
 *
 * `ensureRateLimit` is injected by the caller so uploads share the same
 * rate-limit bucket as other Notion API calls (2 req/s).
 *
 * Files expire in 1 hour unless attached to Notion content.
 * Throws on network errors, API errors, or files exceeding 20 MB.
 *
 * https://developers.notion.com/guides/data-apis/uploading-small-files
 */
export async function uploadFileToNotion(
    fileWithMetadata: NotionFileFromWebhook,
    ensureRateLimit: () => Promise<void>,
): Promise<FileUploadResult | void> {
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
        throw new Error("NOTION_API_KEY is not set");
    }

    const fileBlobFromNotion: Blob = await fetch(fileWithMetadata.file.url).then(res => {
        if (!res.ok) {
            throw new Error(`Failed to download file from Notion URL (${res.status}): ${res.statusText}`);
        } return res.blob();
    });

    console.log(fileBlobFromNotion)

    const filename = fileWithMetadata.name;
    const contentType = getMimeType(filename);
    const notionHeaders = {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": NOTION_API_VERSION,
    };

    // Step 1: Create file upload object
    await ensureRateLimit();
    const createResponse = await fetch(FILE_UPLOAD_ENDPOINT, {
        method: "POST",
        headers: { ...notionHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ filename, content_type: contentType, mode: "single_part" }),
    });
    if (!createResponse.ok) {
        const body = await createResponse.text();
        throw new Error(`Failed to create file upload (${createResponse.status}): ${body}`);
    }

    const { id: fileUploadId, upload_url: uploadUrl } = (await createResponse.json()) as {
        id: string;
        upload_url: string;
        expiry_time: string;
    };

    // Step 2: Upload file content as multipart/form-data

    const fileBinaryContentInFormEncoding = Buffer.from(await fileBlobFromNotion.arrayBuffer());

    const form = new FormData();
    form.append("file", new Blob([fileBinaryContentInFormEncoding], { type: contentType }), filename);

    await ensureRateLimit();
    const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: notionHeaders,
        body: form,
    });
    if (!uploadResponse.ok) {
        const body = await uploadResponse.text();
        throw new Error(`Failed to upload file content (${uploadResponse.status}): ${body}`);
    }

    return { fileUploadId, filename };
}
