import { createBrowserDuckDb, servePeer } from './duckdbBrowser.ts';
import { startWorkerRuntime } from './workerRuntime.ts';

const duckdb = createBrowserDuckDb();
startWorkerRuntime(duckdb.handle, servePeer(duckdb));
