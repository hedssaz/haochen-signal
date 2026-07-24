#!/usr/bin/env node
import process from 'node:process';
import {CLI_NAME, PRODUCT_ENGLISH_NAME, PRODUCT_NAME, VERSION} from '../meta.js';

const args = new Set(process.argv.slice(2));
if (args.has('--version') || args.has('-v')) {
  process.stdout.write(`${VERSION}\n`);
} else if (args.has('--help') || args.has('-h')) {
  process.stdout.write(
    `${PRODUCT_NAME} · ${PRODUCT_ENGLISH_NAME}\n\nUsage: ${CLI_NAME} [--help] [--version]\n`,
  );
} else {
  process.stdout.write('身份确认——浩宸代理，已进入信号场。\n');
}
