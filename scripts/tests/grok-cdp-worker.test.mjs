import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
    defaultPort,
    isUrlAllowed,
    parseCli,
    resolveAgentName,
    resolveAgentProfile,
    selectPageTarget,
    validateWorkflow,
} from '../grok-cdp-worker.mjs';

function workflow(risk, actions, extra = {}) {
    return {
        schemaVersion: 1,
        name: 'test-workflow',
        risk,
        actions,
        ...extra,
    };
}

test('agent profiles keep Cursor and Codex on separate CDP ports', () => {
    const previousAgent = process.env.GAA_GROK_AGENT;
    const previousPort = process.env.GAA_GROK_CDP_PORT;
    try {
        delete process.env.GAA_GROK_AGENT;
        delete process.env.GAA_GROK_CDP_PORT;
        assert.equal(resolveAgentName(), 'cursor');
        assert.equal(defaultPort(), 9334);
        assert.equal(resolveAgentProfile('codex').port, 9333);
        assert.equal(resolveAgentProfile('codex').profileName, 'ChromeProfile');
        process.env.GAA_GROK_AGENT = 'codex';
        assert.equal(defaultPort(), 9333);
        process.env.GAA_GROK_CDP_PORT = '9444';
        assert.equal(defaultPort(), 9444);
        assert.throws(() => resolveAgentName('claude'), /Unknown GAA_GROK_AGENT/);
    }
    finally {
        if (previousAgent == null) delete process.env.GAA_GROK_AGENT;
        else process.env.GAA_GROK_AGENT = previousAgent;
        if (previousPort == null) delete process.env.GAA_GROK_CDP_PORT;
        else process.env.GAA_GROK_CDP_PORT = previousPort;
    }
});

test('parseCli supports positional commands and valued flags', () => {
    assert.deepEqual(
        parseCli(['run', 'workflow.json', '--confirm-quota=run-1']),
        {
            command: 'run',
            positional: ['workflow.json'],
            flags: { 'confirm-quota': 'run-1' },
        },
    );
});

test('URL allowlist accepts Grok and rejects unrelated hosts and unsafe schemes', () => {
    assert.equal(isUrlAllowed('https://grok.com/imagine'), true);
    assert.equal(isUrlAllowed('https://accounts.x.com/login'), true);
    assert.equal(isUrlAllowed('https://example.com/'), false);
    assert.equal(isUrlAllowed('javascript:alert(1)'), false);
});

test('selectPageTarget requires an unambiguous matching target', () => {
    const targets = [
        { id: 'one', type: 'page', url: 'chrome://newtab/', webSocketDebuggerUrl: 'ws://one' },
        { id: 'two', type: 'page', url: 'https://grok.com/imagine', webSocketDebuggerUrl: 'ws://two' },
    ];
    assert.equal(selectPageTarget(targets, { urlContains: 'grok.com' }).id, 'two');
    assert.equal(selectPageTarget(targets, { urlContains: 'missing.example' }), null);
    assert.throws(
        () => selectPageTarget([...targets, { ...targets[1], id: 'three' }], { urlContains: 'grok.com' }),
        /Multiple page targets/,
    );
});

test('workflow validation accepts a bounded read-only workflow', () => {
    const value = workflow('READ_ONLY', [
        { type: 'wait', selector: 'body' },
        { type: 'snapshot', maxText: 2000 },
    ]);
    assert.equal(validateWorkflow(value), value);
});

test('workflow validation rejects a missing schema and invalid name', () => {
    assert.throws(() => validateWorkflow({ name: 'test', risk: 'READ_ONLY', actions: [{ type: 'snapshot' }] }), /schemaVersion/);
    assert.throws(() => validateWorkflow(workflow('READ_ONLY', [{ type: 'snapshot' }], { name: 'Not Valid' })), /lower-case/);
});

test('workflow validation rejects lower declared risk', () => {
    assert.throws(
        () => validateWorkflow(workflow('READ_ONLY', [{ type: 'navigate', url: 'https://grok.com/imagine' }])),
        /lower than required/,
    );
    assert.throws(
        () => validateWorkflow(workflow('LOCAL_STATE', [{ type: 'click', text: 'Generate' }])),
        /lower than required/,
    );
});

test('quota-risk workflow requires a matching confirmation token', () => {
    const value = workflow('QUOTA_RISK', [{ type: 'click', text: 'Generate' }], { confirmationId: 'run-42' });
    assert.throws(() => validateWorkflow(value), /--confirm-quota=run-42/);
    assert.throws(() => validateWorkflow(value, { confirmationToken: 'wrong' }), /--confirm-quota=run-42/);
    assert.equal(validateWorkflow(value, { confirmationToken: 'run-42' }), value);
});

test('quota-risk declaration cannot omit confirmation even for read-only actions', () => {
    assert.throws(
        () => validateWorkflow(workflow('QUOTA_RISK', [{ type: 'snapshot' }])),
        /requires confirmationId/,
    );
});

test('workflow validation rejects unsafe navigation and unknown actions', () => {
    assert.throws(
        () => validateWorkflow(workflow('LOCAL_STATE', [{ type: 'navigate', url: 'https://example.com' }])),
        /restricted/,
    );
    assert.throws(
        () => validateWorkflow(workflow('READ_ONLY', [{ type: 'delete-everything' }])),
        /Unsupported workflow action/,
    );
});

test('workflow validation enforces bounded waits, sleeps, snapshots, and evaluate expressions', () => {
    assert.throws(() => validateWorkflow(workflow('READ_ONLY', [{ type: 'wait', selector: 'body', timeoutMs: 120001 }])), /between/);
    assert.throws(() => validateWorkflow(workflow('READ_ONLY', [{ type: 'sleep', ms: 60001 }])), /between/);
    assert.throws(() => validateWorkflow(workflow('READ_ONLY', [{ type: 'snapshot', maxText: 20001 }])), /between/);
    assert.throws(
        () => validateWorkflow(workflow('QUOTA_RISK', [{ type: 'evaluate', expression: '' }], { confirmationId: 'eval-1' }), { confirmationToken: 'eval-1' }),
        /requires expression/,
    );
});

test('upload is quota-risk and only accepts an absolute image path', () => {
    const confirmationId = 'upload-1';
    const imagePath = resolve('reference.png');
    const value = workflow('QUOTA_RISK', [
        { type: 'upload', filePath: imagePath, selector: 'input[type="file"]' },
    ], { confirmationId });
    assert.equal(validateWorkflow(value, { confirmationToken: confirmationId }), value);
    assert.throws(
        () => validateWorkflow(workflow('LOCAL_STATE', [{ type: 'upload', filePath: imagePath }])),
        /lower than required/,
    );
    assert.throws(
        () => validateWorkflow(workflow('QUOTA_RISK', [{ type: 'upload', filePath: 'reference.png' }], { confirmationId }), { confirmationToken: confirmationId }),
        /must be absolute/,
    );
    assert.throws(
        () => validateWorkflow(workflow('QUOTA_RISK', [{ type: 'upload', filePath: resolve('reference.txt') }], { confirmationId }), { confirmationToken: confirmationId }),
        /only permits image files/,
    );
});

test('download is quota-risk and keeps artifacts under the local state root', () => {
    const confirmationId = 'download-1';
    const value = workflow('QUOTA_RISK', [
        { type: 'download', iconPathPrefix: 'M4.16667 13.3333', directory: 'downloads/test', timeoutMs: 30000 },
    ], { confirmationId });
    assert.equal(validateWorkflow(value, { confirmationToken: confirmationId }), value);
    assert.throws(
        () => validateWorkflow(workflow('LOCAL_STATE', [{ type: 'download', selector: 'button.download' }])),
        /lower than required/,
    );
    assert.throws(
        () => validateWorkflow(workflow('QUOTA_RISK', [{ type: 'download', directory: 'downloads/test' }], { confirmationId }), { confirmationToken: confirmationId }),
        /requires selector, text, or iconPathPrefix/,
    );
    assert.throws(
        () => validateWorkflow(workflow('QUOTA_RISK', [{ type: 'download', selector: 'button.download', directory: '..\\outside' }], { confirmationId }), { confirmationToken: confirmationId }),
        /must stay under/,
    );
    assert.throws(
        () => validateWorkflow(workflow('QUOTA_RISK', [{ type: 'download', iconPathPrefix: 'short' }], { confirmationId }), { confirmationToken: confirmationId }),
        /at least 8 characters/,
    );
});

test('media-download requires exact media dimensions and a safe destination', () => {
    const confirmationId = 'media-download-1';
    const value = workflow('QUOTA_RISK', [
        { type: 'media-download', tag: 'IMG', width: 7680, height: 960, sourceSuffix: '.png', directory: 'downloads/test', fileName: 'sheet.png' },
    ], { confirmationId });
    assert.equal(validateWorkflow(value, { confirmationToken: confirmationId }), value);
    assert.throws(
        () => validateWorkflow(workflow('QUOTA_RISK', [{ type: 'media-download', tag: 'IMG', width: 7680, height: 960, fileName: '..\\secret.png' }], { confirmationId }), { confirmationToken: confirmationId }),
        /safe fileName/,
    );
    assert.throws(
        () => validateWorkflow(workflow('QUOTA_RISK', [{ type: 'media-download', tag: 'AUDIO', width: 1, height: 1, fileName: 'bad.bin' }], { confirmationId }), { confirmationToken: confirmationId }),
        /IMG or VIDEO/,
    );
});
