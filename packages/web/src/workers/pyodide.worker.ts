import { createBrowserPyodide } from './pyodideBrowser.ts';
import { startWorkerRuntime } from './workerRuntime.ts';

const py = createBrowserPyodide();
startWorkerRuntime(py.handle, py.attachPeer);
