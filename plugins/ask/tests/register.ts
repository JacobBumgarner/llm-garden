/** Entry for `node --import`: installs the stub resolution hook before the tests load. */

import { register } from "node:module";

register("./hooks.ts", import.meta.url);
