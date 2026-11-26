import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// Feature: platform-foundation, Property 8: Dependency rule rejects forbidden domain imports
// Validates: Requirements 4.2, 4.3

const apiRoot = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(apiRoot, '.dependency-cruiser.cjs');
const DEPCRUISE_BIN = path.join(
  apiRoot,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);
const TEST_TIMEOUT_MS = 60_000;

// The fixtures live in the OS temp dir without node_modules, so every package below is
// unresolved. The rule must still report them through the bare module name.
const FORBIDDEN_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  ['@nestjs/common', "import { Injectable } from '@nestjs/common';"],
  ['@aws-sdk/client-dynamodb', "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';"],
  ['express', "import express from 'express';"],
  ['axios', "import axios from 'axios';"],
  ['node-fetch', "import fetch from 'node-fetch';"],
  ['got', "import got from 'got';"],
  ['undici', "import { fetch } from 'undici';"],
  ['superagent', "import request from 'superagent';"],
  ['@nestjs/common (type-only)', "import type { Injectable } from '@nestjs/common';"],
  ['express (type-only)', "import type { Request } from 'express';"],
];

const FORBIDDEN_LAYER_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  [
    'application layer',
    "import { GetProducts } from '../application/use-cases/get-products';\nexport const useCase = GetProducts;\n",
  ],
  [
    'infrastructure layer',
    "import { ProductsController } from '../infrastructure/http/products.controller';\nexport const controller = ProductsController;\n",
  ],
];

const LAYER_TARGETS: Readonly<Record<string, string>> = {
  'src/application/use-cases/get-products.ts': 'export const GetProducts = 1;\n',
  'src/infrastructure/http/products.controller.ts': 'export const ProductsController = 1;\n',
};

const roots: string[] = [];

function createFixture(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-rule-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

function runDepcruise(root: string): number | null {
  const result = spawnSync(process.execPath, [DEPCRUISE_BIN, 'src', '--config', CONFIG_PATH], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('dependency-cruiser domain rule (Property 8)', () => {
  describe('rejects forbidden imports from src/domain', () => {
    it.each(FORBIDDEN_IMPORTS)(
      'reports a violation for %s',
      (_label, statement) => {
        const root = createFixture({
          'src/domain/entity.ts': `${statement}\nexport const value = 1;\n`,
        });
        expect(runDepcruise(root)).not.toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it.each(FORBIDDEN_LAYER_IMPORTS)(
      'reports a violation for an import of the %s',
      (_label, statement) => {
        const root = createFixture({
          'src/domain/entity.ts': statement,
          ...LAYER_TARGETS,
        });
        expect(runDepcruise(root)).not.toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('accepts clean domain code', () => {
    it(
      'accepts a domain file with no imports',
      () => {
        const root = createFixture({
          'src/domain/money.ts': 'export const ZERO_COP = 0;\n',
        });
        expect(runDepcruise(root)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'accepts a relative import between files inside src/domain',
      () => {
        const root = createFixture({
          'src/domain/currency.ts': "export type Currency = 'COP';\n",
          'src/domain/money.ts':
            "import type { Currency } from './currency';\nexport const currency: Currency = 'COP';\n",
        });
        expect(runDepcruise(root)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'accepts application code that depends on the domain',
      () => {
        const root = createFixture({
          'src/domain/money.ts': 'export const ZERO_COP = 0;\n',
          'src/application/ports/clock.ts':
            "import { ZERO_COP } from '../../domain/money';\nexport const start = ZERO_COP;\n",
        });
        expect(runDepcruise(root)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  });

  it(
    'passes on the committed src/ tree through npm run depcruise',
    () => {
      const result = spawnSync('npm', ['run', 'depcruise'], {
        cwd: apiRoot,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
