#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9333;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WORKFLOW_TIMEOUT_MS = 300_000;
const MAX_WAIT_TIMEOUT_MS = 120_000;
const MAX_SLEEP_MS = 60_000;
const MAX_SNAPSHOT_TEXT = 20_000;
const MAX_EVALUATE_LENGTH = 20_000;
const MAX_ACTIONS = 100;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);
const PLUGIN_VERSION = '0.1.0';
const AGENT_PROFILES = {
    cursor: { port: 9334, profileName: 'ChromeProfileCursor' },
    codex: { port: 9333, profileName: 'ChromeProfile' },
};
const WORKFLOW_RISKS = ['READ_ONLY', 'LOCAL_STATE', 'QUOTA_RISK'];
const ACTION_RISK = {
    wait: 'READ_ONLY',
    assert: 'READ_ONLY',
    sleep: 'READ_ONLY',
    snapshot: 'READ_ONLY',
    navigate: 'LOCAL_STATE',
    screenshot: 'LOCAL_STATE',
    click: 'QUOTA_RISK',
    fill: 'QUOTA_RISK',
    press: 'QUOTA_RISK',
    upload: 'QUOTA_RISK',
    download: 'QUOTA_RISK',
    'media-download': 'QUOTA_RISK',
    evaluate: 'QUOTA_RISK',
};
const DEFAULT_ALLOWED_HOSTS = ['grok.com', 'x.com', 'accounts.x.ai', 'accounts.x.com'];

function sleep(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function resolveAgentName(value = process.env.GAA_GROK_AGENT) {
    const raw = String(value || 'cursor').trim().toLowerCase();
    if (!AGENT_PROFILES[raw]) {
        throw new Error(`Unknown GAA_GROK_AGENT: ${raw}. Use cursor or codex.`);
    }
    return raw;
}

function resolveAgentProfile(value = process.env.GAA_GROK_AGENT) {
    return AGENT_PROFILES[resolveAgentName(value)];
}

function defaultPort() {
    if (process.env.GAA_GROK_CDP_PORT) {
        return numericFlag(process.env.GAA_GROK_CDP_PORT, DEFAULT_PORT, 'GAA_GROK_CDP_PORT');
    }
    return resolveAgentProfile().port;
}

function localStateRoot() {
    if (process.env.GAA_GROK_STATE_ROOT) {
        return resolve(process.env.GAA_GROK_STATE_ROOT);
    }
    if (process.env.VESPERIX_GROK_STATE_ROOT) {
        return resolve(process.env.VESPERIX_GROK_STATE_ROOT);
    }
    const base = process.env.LOCALAPPDATA || join(homedir(), '.game-assets-automation');
    const next = join(base, 'GameAssetsAutomation', 'GrokCdp');
    const legacy = join(base, 'VESPERIX', 'GrokCdp');
    if (!existsSync(next) && existsSync(legacy)) {
        return legacy;
    }
    return next;
}

function defaultProfileDir() {
    if (process.env.GAA_GROK_PROFILE_DIR) {
        return resolve(process.env.GAA_GROK_PROFILE_DIR);
    }
    return join(localStateRoot(), resolveAgentProfile().profileName);
}

function parseCli(argv) {
    const positional = [];
    const flags = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) {
            positional.push(token);
            continue;
        }
        const equalIndex = token.indexOf('=');
        if (equalIndex > 2) {
            flags[token.slice(2, equalIndex)] = token.slice(equalIndex + 1);
            continue;
        }
        const name = token.slice(2);
        const next = argv[index + 1];
        if (next != null && !next.startsWith('--')) {
            flags[name] = next;
            index += 1;
        }
        else {
            flags[name] = true;
        }
    }
    return { command: positional[0] || 'help', positional: positional.slice(1), flags };
}

function numericFlag(value, fallback, name) {
    if (value == null) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--${name} must be a positive number.`);
    }
    return parsed;
}

function boundedNumber(value, fallback, name, minimum, maximum) {
    const parsed = numericFlag(value, fallback, name);
    if (parsed < minimum || parsed > maximum) {
        throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
    }
    return parsed;
}

function riskRank(risk) {
    return WORKFLOW_RISKS.indexOf(risk);
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function resolveWorkflowArtifactPath(value) {
    if (!value) return null;
    const stateRoot = resolve(localStateRoot());
    const outputPath = isAbsolute(value) ? resolve(value) : resolve(stateRoot, value);
    const fromRoot = relative(stateRoot, outputPath);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
        throw new Error(`Workflow artifacts must stay under ${stateRoot}: ${value}`);
    }
    return outputPath;
}

async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function withTimeout(promise, timeoutMs, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, rejectPromise) => {
                timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}

function configuredAllowedHosts() {
    const configured = process.env.GAA_GROK_ALLOWED_HOSTS || process.env.VESPERIX_GROK_ALLOWED_HOSTS;
    return (configured ? configured.split(',') : DEFAULT_ALLOWED_HOSTS)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
}

function isUrlAllowed(value, allowedHosts = configuredAllowedHosts()) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return false;
    }
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase();
    return allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

function assertAllowedUrl(value) {
    if (!isUrlAllowed(value)) {
        throw new Error(`Navigation is restricted to the Grok login and service hosts. Refused: ${value}`);
    }
}

async function httpJson(path, { host, port, method = 'GET', timeoutMs = 4_000 } = {}) {
    const response = await fetch(`http://${host}:${port}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new Error(`CDP HTTP ${method} ${path} failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

class CdpClient {
    constructor(url, { commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
        this.url = url;
        this.commandTimeoutMs = commandTimeoutMs;
        this.nextId = 0;
        this.pending = new Map();
        this.socket = new WebSocket(url);
        this.ready = new Promise((resolveReady, rejectReady) => {
            const timer = setTimeout(() => rejectReady(new Error('CDP WebSocket open timed out.')), 10_000);
            this.socket.addEventListener('open', () => {
                clearTimeout(timer);
                resolveReady();
            }, { once: true });
            this.socket.addEventListener('error', () => {
                clearTimeout(timer);
                rejectReady(new Error('CDP WebSocket failed to open.'));
            }, { once: true });
        });
        this.socket.addEventListener('message', async (event) => {
            let raw = event.data;
            if (typeof raw !== 'string') {
                if (raw && typeof raw.text === 'function') raw = await raw.text();
                else raw = Buffer.from(raw).toString('utf8');
            }
            let message;
            try {
                message = JSON.parse(raw);
            }
            catch {
                return;
            }
            if (!message.id || !this.pending.has(message.id)) return;
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
            else pending.resolve(message.result);
        });
        const failPending = (reason) => {
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error(reason));
            }
            this.pending.clear();
        };
        this.socket.addEventListener('close', () => failPending('CDP WebSocket closed.'));
        this.socket.addEventListener('error', () => failPending('CDP WebSocket error.'));
    }

    async send(method, params = {}) {
        await this.ready;
        const id = ++this.nextId;
        return new Promise((resolveResult, rejectResult) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    rejectResult(new Error(`CDP command timed out: ${method}`));
                }
            }, this.commandTimeoutMs);
            this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
            try {
                this.socket.send(JSON.stringify({ id, method, params }));
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                rejectResult(error);
            }
        });
    }

    close() {
        try {
            this.socket.close();
        }
        catch {
            // Best effort only.
        }
    }
}

async function evaluate(client, expression) {
    const result = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        includeCommandLineAPI: true,
    });
    if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
        throw new Error(`Page evaluation failed: ${detail}`);
    }
    return result.result?.value;
}

async function listTargets(connection) {
    return httpJson('/json/list', connection);
}

function selectPageTarget(targets, { targetId, urlContains = 'grok.com' } = {}) {
    const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (targetId) {
        const exact = pages.find((target) => target.id === targetId);
        if (!exact) throw new Error(`CDP target disappeared: ${targetId}`);
        return exact;
    }
    const preferred = pages.filter((target) => String(target.url || '').includes(urlContains));
    if (preferred.length > 1) {
        throw new Error(`Multiple page targets match ${urlContains}; pass --target-id explicitly.`);
    }
    return preferred[0] || null;
}

async function openTarget(connection, url) {
    assertAllowedUrl(url);
    return httpJson(`/json/new?${encodeURIComponent(url)}`, { ...connection, method: 'PUT' });
}

function visibilityExpression(action) {
    const payload = JSON.stringify({
        selector: action.selector || null,
        text: action.text || null,
        iconPathPrefix: action.iconPathPrefix || null,
        exact: action.exact === true,
        index: Number(action.index || 0),
    });
    return `(() => {
        const options = ${payload};
        const visible = (element) => {
            if (!element) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        let elements = options.selector
            ? [...document.querySelectorAll(options.selector)]
            : [...document.querySelectorAll('button,a,[role="button"],input,textarea,[contenteditable="true"]')];
        if (options.text != null) {
            const expected = String(options.text).trim();
            elements = elements.filter((element) => {
                const actual = String(element.innerText || element.textContent || element.value || '').trim();
                return options.exact ? actual === expected : actual.includes(expected);
            });
        }
        if (options.iconPathPrefix != null) {
            elements = elements.filter((element) => [...element.querySelectorAll('svg path')]
                .some((path) => String(path.getAttribute('d') || '').startsWith(options.iconPathPrefix)));
        }
        const element = elements[options.index] || null;
        return {
            exists: !!element,
            visible: visible(element),
            text: element ? String(element.innerText || element.textContent || element.value || '').trim().slice(0, 500) : '',
        };
    })()`;
}

async function waitForAction(client, action) {
    const timeoutMs = numericFlag(action.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 'timeoutMs');
    const pollMs = numericFlag(action.pollMs, 250, 'pollMs');
    const state = action.state || 'visible';
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await evaluate(client, visibilityExpression(action));
        const matched = state === 'visible' ? last.visible
            : state === 'exists' ? last.exists
                : state === 'hidden' ? !last.visible
                    : state === 'missing' ? !last.exists
                        : false;
        if (matched) return last;
        await sleep(pollMs);
    }
    throw new Error(`wait timed out (${state}): ${JSON.stringify({ selector: action.selector, text: action.text, last })}`);
}

function clickExpression(action) {
    const locate = visibilityExpression(action);
    const payload = JSON.stringify({
        selector: action.selector || null,
        text: action.text || null,
        iconPathPrefix: action.iconPathPrefix || null,
        exact: action.exact === true,
        index: Number(action.index || 0),
    });
    return `(() => {
        const options = ${payload};
        const probe = (${locate});
        let elements = options.selector
            ? [...document.querySelectorAll(options.selector)]
            : [...document.querySelectorAll('button,a,[role="button"]')];
        if (options.text != null) {
            const expected = String(options.text).trim();
            elements = elements.filter((element) => {
                const actual = String(element.innerText || element.textContent || '').trim();
                return options.exact ? actual === expected : actual.includes(expected);
            });
        }
        if (options.iconPathPrefix != null) {
            elements = elements.filter((element) => [...element.querySelectorAll('svg path')]
                .some((path) => String(path.getAttribute('d') || '').startsWith(options.iconPathPrefix)));
        }
        const element = elements[options.index] || null;
        if (!element) return { clicked: false, reason: 'not_found', probe };
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return { clicked: true, tag: element.tagName, text: String(element.innerText || element.textContent || '').trim().slice(0, 200) };
    })()`;
}

function fillExpression(action) {
    const payload = JSON.stringify({
        selector: action.selector || null,
        placeholder: action.placeholder || null,
        label: action.label || null,
        value: String(action.value ?? action.text ?? ''),
    });
    return `(() => {
        const options = ${payload};
        let element = options.selector ? document.querySelector(options.selector) : null;
        if (!element && options.placeholder) {
            element = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')]
                .find((item) => item.getAttribute('placeholder') === options.placeholder);
        }
        if (!element && options.label) {
            const label = [...document.querySelectorAll('label')]
                .find((item) => String(item.innerText || item.textContent || '').trim() === options.label);
            element = label?.control || (label?.htmlFor ? document.getElementById(label.htmlFor) : null);
        }
        if (!element) return { filled: false, reason: 'not_found' };
        element.focus();
        if (element.isContentEditable) {
            element.textContent = options.value;
        }
        else {
            const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (setter) setter.call(element, options.value);
            else element.value = options.value;
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: options.value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: true, tag: element.tagName, length: options.value.length };
    })()`;
}

function keyDescription(key) {
    const mapping = {
        Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    };
    if (!mapping[key]) throw new Error(`Unsupported key: ${key}. Supported: ${Object.keys(mapping).join(', ')}`);
    return mapping[key];
}

async function pressAction(client, action) {
    const description = keyDescription(action.key);
    const modifiers = Number(action.modifiers || 0);
    const params = { ...description, modifiers, nativeVirtualKeyCode: description.windowsVirtualKeyCode };
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    return { pressed: action.key };
}

function validateUploadPath(value, actionIndex = null) {
    const label = actionIndex == null ? 'upload action' : `upload action ${actionIndex}`;
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} requires filePath.`);
    }
    if (!isAbsolute(value)) {
        throw new Error(`${label} filePath must be absolute.`);
    }
    const extension = extname(value).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
        throw new Error(`${label} only permits image files: ${[...ALLOWED_UPLOAD_EXTENSIONS].join(', ')}.`);
    }
    return resolve(value);
}

async function uploadAction(client, action) {
    const filePath = validateUploadPath(action.filePath);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`Upload path is not a file: ${filePath}`);
    if (fileStat.size <= 0 || fileStat.size > MAX_UPLOAD_BYTES) {
        throw new Error(`Upload image must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes.`);
    }
    const selector = action.selector || 'input[type="file"]';
    const documentNode = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const query = await client.send('DOM.querySelector', {
        nodeId: documentNode.root.nodeId,
        selector,
    });
    if (!query.nodeId) throw new Error(`Upload input not found: ${selector}`);
    await client.send('DOM.setFileInputFiles', {
        nodeId: query.nodeId,
        files: [filePath],
    });
    return {
        uploaded: true,
        fileName: basename(filePath),
        bytes: fileStat.size,
        selector,
    };
}

async function downloadAction(client, action) {
    const outputDirectory = resolveWorkflowArtifactPath(action.directory || 'downloads');
    await mkdir(outputDirectory, { recursive: true });
    const before = new Set(await readdir(outputDirectory));
    await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: outputDirectory,
        eventsEnabled: false,
    });
    const clickResult = await evaluate(client, clickExpression(action));
    if (!clickResult?.clicked) throw new Error(`download click failed: ${JSON.stringify(clickResult)}`);
    const timeoutMs = boundedNumber(action.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 'download.timeoutMs', 1, MAX_WAIT_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    let completedPath = null;
    while (Date.now() < deadline) {
        const names = await readdir(outputDirectory);
        const candidates = names.filter((name) => !before.has(name) && !name.endsWith('.crdownload'));
        if (candidates.length > 0 && !names.some((name) => name.endsWith('.crdownload'))) {
            candidates.sort();
            completedPath = join(outputDirectory, candidates[candidates.length - 1]);
            break;
        }
        await sleep(250);
    }
    if (!completedPath) throw new Error(`Download did not complete within ${timeoutMs} ms.`);
    const fileStat = await stat(completedPath);
    if (!fileStat.isFile() || fileStat.size <= 0) throw new Error(`Downloaded artifact is empty or invalid: ${completedPath}`);
    const digest = sha256(await readFile(completedPath));
    return {
        downloaded: true,
        path: completedPath,
        fileName: basename(completedPath),
        bytes: fileStat.size,
        sha256: digest,
    };
}

function validateDownloadDestination(action, actionIndex = null) {
    const label = actionIndex == null ? 'media-download action' : `media-download action ${actionIndex}`;
    if (typeof action.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(action.fileName)) {
        throw new Error(`${label} requires a safe fileName.`);
    }
    const directory = resolveWorkflowArtifactPath(action.directory || 'downloads');
    return join(directory, action.fileName);
}

async function mediaDownloadAction(client, action) {
    const outputPath = validateDownloadDestination(action);
    const payload = JSON.stringify({
        tag: action.tag ? String(action.tag).toUpperCase() : null,
        width: Number(action.width),
        height: Number(action.height),
        sourceSuffix: action.sourceSuffix || null,
    });
    const source = await evaluate(client, `(() => {
        const expected = ${payload};
        const matches = [...document.querySelectorAll('img,video')]
            .filter((element) => !expected.tag || element.tagName === expected.tag)
            .filter((element) => {
                const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
                const height = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
                return width === expected.width && height === expected.height;
            })
            .map((element) => String(element.currentSrc || element.src || ''))
            .filter((value) => value && (!expected.sourceSuffix || value.toLowerCase().split(/[?#]/)[0].endsWith(expected.sourceSuffix.toLowerCase())));
        const unique = [...new Set(matches)];
        return unique.length === 1 ? unique[0] : { error: 'ambiguous_media', count: unique.length };
    })()`);
    if (typeof source !== 'string') throw new Error(`media-download requires exactly one matching visible-page media source; found ${source?.count ?? 0}.`);
    if (!source.startsWith('https://')) throw new Error('media-download only permits HTTPS media sources.');
    let bytes = null;
    try {
        const response = await fetch(source, { signal: AbortSignal.timeout(120_000) });
        if (response.ok) {
            const declaredLength = Number(response.headers.get('content-length') || 0);
            if (declaredLength > MAX_DOWNLOAD_BYTES) throw new Error(`Media download exceeds ${MAX_DOWNLOAD_BYTES} bytes.`);
            bytes = Buffer.from(await response.arrayBuffer());
        }
    }
    catch {
        // Fall through to the browser context below.
    }
    if (!bytes) {
        await client.send('Page.enable');
        const frameTree = await client.send('Page.getFrameTree');
        const frameId = frameTree.frameTree.frame.id;
        try {
            const cached = await client.send('Page.getResourceContent', { frameId, url: source });
            bytes = Buffer.from(cached.content, cached.base64Encoded ? 'base64' : 'utf8');
        }
        catch {
            const loaded = await client.send('Network.loadNetworkResource', {
                frameId,
                url: source,
                options: { disableCache: false, includeCredentials: true },
            });
            if (!loaded.resource?.success || !loaded.resource?.stream) {
                throw new Error(`Browser-context media download failed with HTTP ${loaded.resource?.httpStatusCode || 'unknown'}.`);
            }
            const chunks = [];
            let eof = false;
            try {
                while (!eof) {
                    const chunk = await client.send('IO.read', { handle: loaded.resource.stream, size: 1_048_576 });
                    chunks.push(Buffer.from(chunk.data || '', chunk.base64Encoded ? 'base64' : 'utf8'));
                    eof = chunk.eof === true;
                    if (chunks.reduce((total, value) => total + value.length, 0) > MAX_DOWNLOAD_BYTES) {
                        throw new Error(`Media download exceeds ${MAX_DOWNLOAD_BYTES} bytes.`);
                    }
                }
            }
            finally {
                await client.send('IO.close', { handle: loaded.resource.stream }).catch(() => {});
            }
            bytes = Buffer.concat(chunks);
        }
    }
    if (bytes.length <= 0 || bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`Media download must be between 1 byte and ${MAX_DOWNLOAD_BYTES} bytes.`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes);
    return {
        downloaded: true,
        path: outputPath,
        fileName: basename(outputPath),
        bytes: bytes.length,
        sha256: sha256(bytes),
    };
}

function defaultCapturePath(extension = 'png') {
    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return join(localStateRoot(), 'captures', `capture-${safeTimestamp}.${extension}`);
}

async function captureScreenshot(client, requestedPath, action = {}) {
    const format = action.format || 'png';
    if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error(`Unsupported screenshot format: ${format}`);
    const outputPath = requestedPath ? resolve(requestedPath) : defaultCapturePath(format === 'jpeg' ? 'jpg' : format);
    const params = {
        format,
        fromSurface: true,
        captureBeyondViewport: action.fullPage === true,
    };
    if (format !== 'png' && action.quality != null) params.quality = Number(action.quality);
    const result = await client.send('Page.captureScreenshot', params);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(result.data, 'base64'));
    return { path: outputPath, format };
}

function validateWorkflow(workflow, { confirmationToken } = {}) {
    if (!workflow || typeof workflow !== 'object') throw new Error('Workflow must be a JSON object.');
    if (workflow.schemaVersion !== 1) throw new Error('Workflow.schemaVersion must be 1.');
    if (typeof workflow.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(workflow.name)) {
        throw new Error('Workflow.name must be lower-case hyphen-case and at most 64 characters.');
    }
    if (!WORKFLOW_RISKS.includes(workflow.risk)) {
        throw new Error(`Workflow.risk must be one of: ${WORKFLOW_RISKS.join(', ')}.`);
    }
    if (!Array.isArray(workflow.actions)) throw new Error('Workflow.actions must be an array.');
    if (workflow.actions.length === 0) throw new Error('Workflow.actions must not be empty.');
    if (workflow.actions.length > MAX_ACTIONS) throw new Error(`Workflow exceeds ${MAX_ACTIONS} actions.`);
    let requiredRisk = 'READ_ONLY';
    workflow.actions.forEach((action, index) => {
        if (!action || typeof action !== 'object' || !ACTION_RISK[action.type]) {
            throw new Error(`Unsupported workflow action at index ${index}: ${action?.type}`);
        }
        if (riskRank(ACTION_RISK[action.type]) > riskRank(requiredRisk)) requiredRisk = ACTION_RISK[action.type];
        if (action.type === 'navigate') {
            if (typeof action.url !== 'string') throw new Error(`navigate action ${index} requires url.`);
            assertAllowedUrl(action.url);
            boundedNumber(action.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, `actions[${index}].timeoutMs`, 1, MAX_WAIT_TIMEOUT_MS);
        }
        else if (action.type === 'wait' || action.type === 'assert') {
            if (!action.selector && action.text == null) throw new Error(`${action.type} action ${index} requires selector or text.`);
            if (action.state != null && !['visible', 'exists', 'hidden', 'missing'].includes(action.state)) {
                throw new Error(`${action.type} action ${index} has unsupported state: ${action.state}`);
            }
            boundedNumber(action.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, `actions[${index}].timeoutMs`, 1, MAX_WAIT_TIMEOUT_MS);
            boundedNumber(action.pollMs, 250, `actions[${index}].pollMs`, 50, 5_000);
        }
        else if (action.type === 'click') {
            if (!action.selector && action.text == null && !action.iconPathPrefix) throw new Error(`click action ${index} requires selector, text, or iconPathPrefix.`);
        }
        else if (action.type === 'fill') {
            if (!action.selector && !action.placeholder && !action.label) {
                throw new Error(`fill action ${index} requires selector, placeholder, or label.`);
            }
            if (action.value == null && action.text == null) throw new Error(`fill action ${index} requires value or text.`);
        }
        else if (action.type === 'press') {
            keyDescription(action.key);
        }
        else if (action.type === 'upload') {
            validateUploadPath(action.filePath, index);
            if (action.selector != null && (typeof action.selector !== 'string' || action.selector.trim().length === 0)) {
                throw new Error(`upload action ${index} selector must be a non-empty string.`);
            }
        }
        else if (action.type === 'download') {
            if (!action.selector && action.text == null && !action.iconPathPrefix) throw new Error(`download action ${index} requires selector, text, or iconPathPrefix.`);
            if (action.iconPathPrefix != null && (typeof action.iconPathPrefix !== 'string' || action.iconPathPrefix.trim().length < 8)) {
                throw new Error(`download action ${index} iconPathPrefix must contain at least 8 characters.`);
            }
            if (action.directory) resolveWorkflowArtifactPath(action.directory);
            boundedNumber(action.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, `actions[${index}].timeoutMs`, 1, MAX_WAIT_TIMEOUT_MS);
        }
        else if (action.type === 'media-download') {
            boundedNumber(action.width, null, `actions[${index}].width`, 1, 32768);
            boundedNumber(action.height, null, `actions[${index}].height`, 1, 32768);
            if (action.tag != null && !['IMG', 'VIDEO'].includes(String(action.tag).toUpperCase())) {
                throw new Error(`media-download action ${index} tag must be IMG or VIDEO.`);
            }
            if (action.sourceSuffix != null && (typeof action.sourceSuffix !== 'string' || !/^\.[a-z0-9]{2,5}$/i.test(action.sourceSuffix))) {
                throw new Error(`media-download action ${index} sourceSuffix must be a file extension such as .png.`);
            }
            validateDownloadDestination(action, index);
        }
        else if (action.type === 'sleep') {
            boundedNumber(action.ms, 250, `actions[${index}].ms`, 1, MAX_SLEEP_MS);
        }
        else if (action.type === 'screenshot') {
            if (action.path) resolveWorkflowArtifactPath(action.path);
            if (action.format != null && !['png', 'jpeg', 'webp'].includes(action.format)) {
                throw new Error(`screenshot action ${index} has unsupported format: ${action.format}`);
            }
            if (action.quality != null) boundedNumber(action.quality, 90, `actions[${index}].quality`, 1, 100);
        }
        else if (action.type === 'snapshot') {
            boundedNumber(action.maxText, 8_000, `actions[${index}].maxText`, 1, MAX_SNAPSHOT_TEXT);
        }
        else if (action.type === 'evaluate') {
            if (typeof action.expression !== 'string' || action.expression.length === 0 || action.expression.length > MAX_EVALUATE_LENGTH) {
                throw new Error(`evaluate action ${index} requires expression of 1-${MAX_EVALUATE_LENGTH} characters.`);
            }
        }
    });
    if (riskRank(workflow.risk) < riskRank(requiredRisk)) {
        throw new Error(`Workflow risk ${workflow.risk} is lower than required action risk ${requiredRisk}.`);
    }
    if (workflow.risk === 'QUOTA_RISK') {
        if (typeof workflow.confirmationId !== 'string' || workflow.confirmationId.trim().length === 0) {
            throw new Error('QUOTA_RISK workflow requires confirmationId.');
        }
        if (confirmationToken !== workflow.confirmationId) {
            throw new Error(`QUOTA_RISK workflow requires --confirm-quota=${workflow.confirmationId}.`);
        }
    }
    boundedNumber(workflow.timeoutMs, DEFAULT_WORKFLOW_TIMEOUT_MS, 'workflow.timeoutMs', 1, DEFAULT_WORKFLOW_TIMEOUT_MS);
    return workflow;
}

async function pageSnapshot(client, maxText = 8_000) {
    return evaluate(client, `(() => ({
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        text: String(document.body?.innerText || '').slice(0, ${Number(maxText)}),
        media: [...document.querySelectorAll('img,video')].slice(0, 80).map((element, index) => {
            const rect = element.getBoundingClientRect();
            let source = String(element.currentSrc || element.src || '');
            try {
                const parsed = new URL(source, location.href);
                source = parsed.protocol === 'blob:' ? 'blob:' : parsed.origin + parsed.pathname;
            }
            catch {
                source = source ? '[unparseable]' : '';
            }
            return {
                index,
                tag: element.tagName,
                alt: element.getAttribute('alt'),
                width: element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth,
                height: element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight,
                duration: element instanceof HTMLVideoElement && Number.isFinite(element.duration) ? element.duration : null,
                visible: rect.width > 0 && rect.height > 0,
                displayWidth: Math.round(rect.width),
                displayHeight: Math.round(rect.height),
                source,
            };
        }),
        interactives: [...document.querySelectorAll('button,a,input,textarea,[contenteditable="true"],[role="button"]')]
            .filter((element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            })
            .slice(0, 120)
            .map((element, index) => ({
                index,
                tag: element.tagName,
                text: String(element.innerText || element.textContent || element.value || '').trim().slice(0, 160),
                ariaLabel: element.getAttribute('aria-label'),
                placeholder: element.getAttribute('placeholder'),
                title: element.getAttribute('title'),
                dataTestId: element.getAttribute('data-testid'),
                href: element instanceof HTMLAnchorElement ? element.href : null,
                contextText: String(element.closest('article,[role="group"],[data-testid],section')?.innerText || '').trim().slice(0, 240),
                iconPaths: [...element.querySelectorAll('svg path')].slice(0, 3).map((path) => path.getAttribute('d')),
            })),
    }))()`);
}

async function executeWorkflow(client, workflow) {
    const results = [];
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    for (let index = 0; index < workflow.actions.length; index += 1) {
        const action = workflow.actions[index];
        let result;
        if (action.type === 'navigate') {
            assertAllowedUrl(action.url);
            await client.send('Page.navigate', { url: action.url });
            result = await waitForAction(client, {
                selector: 'body',
                state: 'visible',
                timeoutMs: action.timeoutMs || 30_000,
            });
        }
        else if (action.type === 'wait' || action.type === 'assert') {
            result = await waitForAction(client, action);
        }
        else if (action.type === 'click') {
            result = await evaluate(client, clickExpression(action));
            if (!result?.clicked) throw new Error(`click failed: ${JSON.stringify(result)}`);
        }
        else if (action.type === 'fill') {
            result = await evaluate(client, fillExpression(action));
            if (!result?.filled) throw new Error(`fill failed: ${JSON.stringify(result)}`);
        }
        else if (action.type === 'press') {
            result = await pressAction(client, action);
        }
        else if (action.type === 'upload') {
            result = await uploadAction(client, action);
        }
        else if (action.type === 'download') {
            result = await downloadAction(client, action);
        }
        else if (action.type === 'media-download') {
            result = await mediaDownloadAction(client, action);
        }
        else if (action.type === 'sleep') {
            const ms = numericFlag(action.ms, 250, 'ms');
            await sleep(ms);
            result = { sleptMs: ms };
        }
        else if (action.type === 'screenshot') {
            result = await captureScreenshot(client, action.path ? resolveWorkflowArtifactPath(action.path) : undefined, action);
        }
        else if (action.type === 'snapshot') {
            result = await pageSnapshot(client, action.maxText || 8_000);
        }
        else if (action.type === 'evaluate') {
            result = await evaluate(client, action.expression);
        }
        results.push({ index, type: action.type, result });
    }
    return results;
}

function summarizeWorkflowResults(results) {
    return results.map(({ index, type, result }) => {
        const summary = { index, type };
        if (type === 'snapshot') {
            summary.page = {
                title: result?.title,
                url: result?.url,
                readyState: result?.readyState,
                textLength: String(result?.text || '').length,
                interactiveCount: Array.isArray(result?.interactives) ? result.interactives.length : 0,
            };
        }
        else if (type === 'screenshot') {
            summary.artifact = { path: result?.path, format: result?.format };
        }
        else if (type === 'download' || type === 'media-download') {
            summary.artifact = { path: result?.path, fileName: result?.fileName, bytes: result?.bytes, sha256: result?.sha256 };
        }
        else if (type === 'wait' || type === 'assert') {
            summary.matched = { exists: result?.exists, visible: result?.visible };
        }
        else if (type === 'sleep') {
            summary.sleptMs = result?.sleptMs;
        }
        else {
            summary.completed = true;
        }
        return summary;
    });
}

function newRunId(workflowHash) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${timestamp}-${workflowHash.slice(0, 10)}`;
}

function helpText() {
    return `Game Assets Automation Grok CDP Worker

Commands:
  status                          Check CDP and summarize page targets.
  targets                         List page targets.
  open <url>                      Open an allowed Grok/login URL in a new tab.
  snapshot [--url-contains text]  Return visible text and interactives.
  screenshot [path]               Capture the selected page.
  run <workflow.json>             Execute a validated workflow and write a run manifest.
  close-browser                   Gracefully close only the dedicated Chrome instance.

Options:
  --host 127.0.0.1   --port <agent default>   --target-id id   --url-contains grok.com
  --confirm-quota id  Required only for a matching QUOTA_RISK workflow.

Agents:
  cursor  port 9334, profile ChromeProfileCursor
  codex   port 9333, profile ChromeProfile

Set GAA_GROK_AGENT=cursor|codex, or override with GAA_GROK_CDP_PORT / GAA_GROK_PROFILE_DIR.
Profile and credentials live under the local state root, never in the repo.`;
}

async function main(argv = process.argv.slice(2)) {
    const cli = parseCli(argv);
    const connection = {
        host: String(cli.flags.host || DEFAULT_HOST),
        port: numericFlag(cli.flags.port, defaultPort(), 'port'),
    };
    const selection = {
        targetId: cli.flags['target-id'],
        urlContains: String(cli.flags['url-contains'] || 'grok.com'),
    };

    if (cli.command === 'help' || cli.flags.help) {
        console.log(helpText());
        return;
    }
    if (cli.command === 'status') {
        const [version, targets] = await Promise.all([
            httpJson('/json/version', connection),
            listTargets(connection),
        ]);
        console.log(JSON.stringify({
            connected: true,
            browser: version.Browser,
            protocolVersion: version['Protocol-Version'],
            pageCount: targets.filter((target) => target.type === 'page').length,
            pages: targets.filter((target) => target.type === 'page').map((target) => ({ id: target.id, title: target.title, url: target.url })),
        }, null, 2));
        return;
    }
    if (cli.command === 'targets') {
        const targets = await listTargets(connection);
        console.log(JSON.stringify(targets.filter((target) => target.type === 'page').map((target) => ({
            id: target.id,
            title: target.title,
            url: target.url,
        })), null, 2));
        return;
    }
    if (cli.command === 'open') {
        const url = cli.positional[0] || 'https://grok.com/imagine';
        const target = await openTarget(connection, url);
        console.log(JSON.stringify({ opened: true, id: target.id, title: target.title, url: target.url }, null, 2));
        return;
    }
    if (cli.command === 'close-browser') {
        const version = await httpJson('/json/version', connection);
        const client = new CdpClient(version.webSocketDebuggerUrl);
        try {
            await client.send('Browser.close');
            console.log(JSON.stringify({ closed: true }));
        }
        finally {
            client.close();
        }
        return;
    }

    const targets = await listTargets(connection);
    const target = selectPageTarget(targets, selection);
    if (!target) throw new Error('No debuggable page target is available.');
    const client = new CdpClient(target.webSocketDebuggerUrl);
    try {
        await client.ready;
        if (cli.command === 'snapshot') {
            console.log(JSON.stringify(await pageSnapshot(client), null, 2));
        }
        else if (cli.command === 'screenshot') {
            console.log(JSON.stringify(await captureScreenshot(client, cli.positional[0], {
                fullPage: cli.flags['full-page'] === true,
                format: cli.flags.format || 'png',
                quality: cli.flags.quality,
            }), null, 2));
        }
        else if (cli.command === 'run') {
            const workflowPath = cli.positional[0];
            if (!workflowPath) throw new Error('run requires a workflow JSON path.');
            const resolvedWorkflowPath = resolve(workflowPath);
            const workflowSource = await readFile(resolvedWorkflowPath, 'utf8');
            const workflow = validateWorkflow(JSON.parse(workflowSource), {
                confirmationToken: cli.flags['confirm-quota'],
            });
            const workflowHash = sha256(workflowSource);
            const runId = newRunId(workflowHash);
            const manifestPath = join(localStateRoot(), 'runs', runId, 'run.json');
            const manifest = {
                schemaVersion: 1,
                runId,
                pluginVersion: PLUGIN_VERSION,
                workflow: {
                    name: workflow.name,
                    risk: workflow.risk,
                    sourcePath: resolvedWorkflowPath,
                    sha256: workflowHash,
                    actionTypes: workflow.actions.map((action) => action.type),
                    confirmationId: workflow.risk === 'QUOTA_RISK' ? workflow.confirmationId : null,
                },
                target: { id: target.id, title: target.title, url: target.url },
                startedAtUtc: new Date().toISOString(),
                status: 'running',
            };
            await writeJson(manifestPath, manifest);
            try {
                const timeoutMs = boundedNumber(workflow.timeoutMs, DEFAULT_WORKFLOW_TIMEOUT_MS, 'workflow.timeoutMs', 1, DEFAULT_WORKFLOW_TIMEOUT_MS);
                const results = await withTimeout(executeWorkflow(client, workflow), timeoutMs, `Workflow ${workflow.name}`);
                manifest.status = 'tool_completed';
                manifest.finishedAtUtc = new Date().toISOString();
                manifest.results = summarizeWorkflowResults(results);
                await writeJson(manifestPath, manifest);
                console.log(JSON.stringify({
                    target: manifest.target,
                    runId,
                    manifestPath,
                    status: manifest.status,
                    results,
                }, null, 2));
            }
            catch (error) {
                manifest.status = 'failed';
                manifest.finishedAtUtc = new Date().toISOString();
                manifest.error = error.message;
                await writeJson(manifestPath, manifest);
                error.message = `${error.message} Manifest: ${manifestPath}`;
                throw error;
            }
        }
        else {
            throw new Error(`Unknown command: ${cli.command}`);
        }
    }
    finally {
        client.close();
    }
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
    main().catch((error) => {
        console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
        process.exitCode = 1;
    });
}

export {
    AGENT_PROFILES,
    CdpClient,
    defaultPort,
    defaultProfileDir,
    executeWorkflow,
    isUrlAllowed,
    localStateRoot,
    parseCli,
    resolveAgentName,
    resolveAgentProfile,
    selectPageTarget,
    validateWorkflow,
};
