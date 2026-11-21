import { Workbook } from 'exceljs';
import { createIngestHandler } from './ingestHandler.ts';
import { startWorkerRuntime } from './workerRuntime.ts';

// exceljs resolves to its browser build (package.json "browser" field) and lives only in this lazily created worker chunk.
startWorkerRuntime(createIngestHandler(Workbook));
