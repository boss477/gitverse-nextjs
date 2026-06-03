import '@testing-library/jest-dom';
import { TextEncoder, TextDecoder } from 'util';
import { ReadableStream } from 'stream/web';
Object.assign(global, { TextDecoder, TextEncoder, ReadableStream });

const undici = require('undici');
(global as any).Request = undici.Request;
(global as any).Response = undici.Response;

