import * as fs from 'fs';
import * as path from 'path';
import { Collector } from '@boundaryml/baml';

const TRACE_DIR = process.env.MAGNITUDE_TRACE_DIR || process.cwd();
const TRACE_FILE = path.join(TRACE_DIR, `magnitude-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

let traceStream: fs.WriteStream | null = null;
let callSequence = 0;

function getStream(): fs.WriteStream {
    if (!traceStream) {
        traceStream = fs.createWriteStream(TRACE_FILE, { flags: 'a' });
        console.log(`[MAGNITUDE TRACE] Writing LLM traces to: ${TRACE_FILE}`);
    }
    return traceStream;
}

function sanitizeContentForLog(content: any): any {
    if (content === null || content === undefined) return content;
    if (typeof content === 'string') {
        if (content.length > 500) {
            return content.substring(0, 500) + `... [truncated, total ${content.length} chars]`;
        }
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(sanitizeContentForLog);
    }
    if (typeof content === 'object') {
        const result: any = {};
        for (const [key, value] of Object.entries(content)) {
            if (key === 'source' && typeof value === 'object' && value !== null && 'media_type' in (value as any)) {
                result[key] = { type: 'base64_image', media_type: (value as any).media_type, size: `${((value as any).data?.length ?? 0)} chars` };
            } else if (key === 'data' && typeof value === 'string' && value.length > 1000) {
                result[key] = `[base64 data, ${value.length} chars]`;
            } else {
                result[key] = sanitizeContentForLog(value);
            }
        }
        return result;
    }
    return content;
}

export interface TraceEntry {
    sequence: number;
    timestamp: string;
    function: string;
    durationMs: number;
    request: {
        systemPrompt: any[];
        messages: any[];
        model?: string;
        rawHttpBody?: any;
    };
    response: {
        parsed: any;
        rawHttpBody?: any;
    };
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
    };
}

export function extractTraceFromCollector(
    collector: Collector,
    functionName: string,
    durationMs: number,
    parsedResponse: any
): TraceEntry {
    const lastLog = collector.last;
    const lastCall = lastLog?.calls.at(-1);

    let requestBody: any = undefined;
    let responseBody: any = undefined;
    let systemPrompt: any[] = [];
    let messages: any[] = [];
    let model: string | undefined;
    let usage: any = undefined;

    if (lastCall) {
        try {
            requestBody = lastCall.httpRequest?.body?.json();
            if (requestBody) {
                messages = requestBody.messages || requestBody.contents || [];
                model = requestBody.model;
                if (requestBody.system) {
                    systemPrompt = Array.isArray(requestBody.system)
                        ? requestBody.system
                        : [{ type: 'text', text: requestBody.system }];
                }
            }
        } catch {}

        try {
            responseBody = lastCall.httpResponse?.body?.json();
            if (responseBody?.usage) {
                usage = responseBody.usage;
            }
        } catch {}
    }

    const entry: TraceEntry = {
        sequence: ++callSequence,
        timestamp: new Date().toISOString(),
        function: functionName,
        durationMs,
        request: {
            systemPrompt,
            messages,
            model,
            rawHttpBody: requestBody,
        },
        response: {
            parsed: parsedResponse,
            rawHttpBody: responseBody,
        },
        ...(usage ? { usage } : {}),
    };

    return entry;
}

function sanitizeMessage(msg: any): any {
    if (!msg) return msg;
    const sanitized: any = { role: msg.role };
    if (typeof msg.content === 'string') {
        sanitized.content = msg.content;
    } else if (Array.isArray(msg.content)) {
        sanitized.content = msg.content.map((part: any) => {
            if (part?.type === 'image' || part?.type === 'image_url') {
                return { type: part.type, detail: '[image data omitted]' };
            }
            if (part?.type === 'image_base64' || (part?.source?.type === 'base64')) {
                return {
                    type: 'image',
                    media_type: part?.source?.media_type || part?.media_type || 'unknown',
                    detail: '[base64 image data omitted]'
                };
            }
            return part;
        });
    } else {
        sanitized.content = msg.content;
    }
    if (msg.cache_control) sanitized.cache_control = msg.cache_control;
    return sanitized;
}

function extractRawResponseText(responseBody: any): string | undefined {
    if (!responseBody) return undefined;
    try {
        const content = responseBody.content || responseBody.choices;
        if (Array.isArray(content)) {
            return content
                .map((c: any) => c.text || c.message?.content || '')
                .filter(Boolean)
                .join('\n');
        }
    } catch {}
    return undefined;
}

export function writeTrace(entry: TraceEntry): void {
    const stream = getStream();

    const rawAssistantResponse = extractRawResponseText(entry.response.rawHttpBody);

    const logEntry = {
        ...entry,
        request: {
            ...entry.request,
            systemPrompt: entry.request.systemPrompt,
            messages: entry.request.messages.map(sanitizeMessage),
            rawHttpBody: undefined,
        },
        response: {
            ...entry.response,
            rawAssistantResponse,
            rawHttpBody: undefined,
        }
    };

    stream.write(JSON.stringify(logEntry) + '\n');

    const fullEntry = {
        ...entry,
        request: {
            ...entry.request,
            rawHttpBody: sanitizeContentForLog(entry.request.rawHttpBody),
        },
        response: {
            ...entry.response,
            rawAssistantResponse,
            rawHttpBody: sanitizeContentForLog(entry.response.rawHttpBody),
        }
    };

    const fullFile = TRACE_FILE.replace('.jsonl', '-full.jsonl');
    fs.appendFileSync(fullFile, JSON.stringify(fullEntry) + '\n');
}

export function closeTraceLogger(): void {
    if (traceStream) {
        traceStream.end();
        traceStream = null;
    }
}
