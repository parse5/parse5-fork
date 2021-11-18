import { Writable } from 'stream';

export class DevNullStream extends Writable {
    override _write(_chunk: string, _encoding: string, cb: () => void) {
        cb();
    }
}
