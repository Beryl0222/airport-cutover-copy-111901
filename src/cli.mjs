#!/usr/bin/env node
// 本地多语种改线路径咨询工具的命令行入口。
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { RerouteService } from './app.mjs';
import { codePointLength } from './render.mjs';

const DATA_FILE = new URL('../data/inputs.json', import.meta.url);
const RUNTIME_DIR = new URL('../runtime/', import.meta.url);

async function loadService() {
  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  return RerouteService.create(data, {
    auditFile: new URL('audit.jsonl', RUNTIME_DIR),
    storeFile: new URL('state.json', RUNTIME_DIR),
  });
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      channel: { type: 'string', default: 'phone' },
      corridor: { type: 'string' },
      notice: { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;
  const service = await loadService();

  switch (command) {
    case 'seed': {
      print(service.seedFromInputs());
      break;
    }
    case 'ask': {
      const [sessionId, ...words] = rest;
      const text = words.join(' ');
      service.ensureSession(sessionId, { lang: values.lang });
      const { parse, response } = await service.ask(sessionId, text);
      const channelId = values.channel === 'phone' ? 'phone' : values.channel;
      print({
        parsed: parse,
        position: service.getSession(sessionId).position,
        response,
        rendered: service.renderResponse(response, channelId),
        length: channelId === 'phone'
          ? codePointLength(service.phoneText(response))
          : undefined,
      });
      break;
    }
    case 'close': {
      const [closureId] = rest;
      const results = await service.submitClosure({
        id: closureId,
        corridor: values.corridor,
        notice: values.notice ?? '',
      });
      print({ reverify: results });
      break;
    }
    case 'open': {
      const [closureId] = rest;
      print({ reverify: await service.reopenCorridor(closureId) });
      break;
    }
    case 'reverify': {
      print(await service.reverifyAll());
      break;
    }
    case 'explain': {
      const [sessionId] = rest;
      print(service.ensureSession(sessionId) && service.explain(sessionId));
      break;
    }
    case 'stale': {
      print(service.staleInstructions());
      break;
    }
    case 'switch-lang': {
      const [sessionId, lang] = rest;
      service.ensureSession(sessionId);
      print(service.switchLanguage(sessionId, lang));
      break;
    }
    case 'demo': {
      const { runDemo } = await import('./demo.mjs');
      print(await runDemo(service));
      break;
    }
    default:
      process.stdout.write(
        [
          '用法:',
          '  node src/cli.mjs seed',
          '  node src/cli.mjs ask <会话号> "<问路原话>" [--channel phone|small-zh|small-en]',
          '  node src/cli.mjs close <封闭号> --corridor <通道号> --notice "<说明>"',
          '  node src/cli.mjs open <封闭号>',
          '  node src/cli.mjs reverify',
          '  node src/cli.mjs explain <会话号>',
          '  node src/cli.mjs stale',
          '  node src/cli.mjs switch-lang <会话号> zh|en',
          '  node src/cli.mjs demo',
        ].join('\n') + '\n',
      );
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
