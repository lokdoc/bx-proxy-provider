import client from './db.js';
import rdb from './rdb.js';

await client.connect();
const db = client.db('bx');
const collection = db.collection('proxy');
let proxies = await collection.find({}).toArray();

import { DecodoProvider } from './DecodoProvider.js';

// Configuration
const CONCURRENT_LIMIT = 50; // Max concurrent fetches
const SESSION_COUNT = 1000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000; // ms
const LOOP_DELAY = 1000 * 10; // 10 seconds

// Concurrency limiter using semaphore pattern
class ConcurrencyLimiter {
    constructor(maxConcurrent) {
        this.maxConcurrent = maxConcurrent;
        this.running = 0;
        this.queue = [];
    }

    async execute(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.running >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        this.running++;
        const { fn, resolve, reject } = this.queue.shift();

        try {
            const result = await fn();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            this.running--;
            this.process();
        }
    }
}

const limiter = new ConcurrencyLimiter(CONCURRENT_LIMIT);

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry wrapper for fetch operations
async function withRetry(fn, attempts = RETRY_ATTEMPTS, delay = RETRY_DELAY) {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === attempts - 1) throw error;
            await wait(delay * (i + 1)); // Exponential backoff
        }
    }
}

async function UpdateSession(sid, p) {
    try {
        let port = Math.floor(Math.random() * 5000) + 10001;
        let d = new DecodoProvider({
            host: p.host,
            username: p.user,
            password: p.pass,
            port: port.toString()
        });
        
        let ip = await withRetry(() => d.getIp());
        ip = ip?.trim();
        
        if (ip == null || ip == "") {
            return null;
        }
        
        console.log(p._id + ":" + port, " ==> ", ip);
        
        const sessionData = {
            _id: p._id,
            ip: ip,
            ts: +new Date(),
            port: port,
            date: new Date().toISOString()
        };
        
        const ipData = {
            _id: p._id,
            ip: ip,
            sessionId: sid,
            providerId: p._id,
            region: p.region,
            port: port,
            ts: +new Date(),
            date: new Date().toISOString()
        };
        
        // Batch Redis operations
        await Promise.all([
            rdb.set(p._id + ":" + sid, JSON.stringify(sessionData)),
            rdb.set("ip:" + ip, JSON.stringify(ipData))
        ]);

        return { p, port, ip };
    } catch (error) {
        console.error(`[!] UpdateSession failed for ${p._id}:${sid}`, error.message);
        return null;
    }
}

async function DropSession(sid, p, ip) {
    try {
        console.log("[!] Dropping session ==> ", sid, " for provider ==> ", p._id, " ip ==> ", ip);
        await Promise.all([
            rdb.del(p._id + ":" + sid),
            rdb.del("ip:" + ip)
        ]);
    } catch (error) {
        console.error(`[!] DropSession failed for ${p._id}:${sid}`, error.message);
    }
}

async function ProcessSession(p, sid) {
    try {
        let key = p._id + ":" + sid;
        let data = await rdb.get(key);
        
        if (data != null) {
            data = JSON.parse(data);
            let d = new DecodoProvider({
                host: p.host,
                username: p.user,
                password: p.pass,
                port: data.port.toString()
            });

            let now = +new Date();
            let timespan = now - data.ts;
            let timespanSeconds = timespan / 1000;
            
            // Skip check if older than 10 minutes (only check recent sessions)
            if (timespanSeconds > 600) {
                return;
            }
            
            let currentIp = await withRetry(() => d.getIp());
            currentIp = currentIp?.trim();
            
            if (currentIp == null || currentIp == "") {
                console.log("[!] Current Ip is empty for port ==> ", data.port, " Dropping session for this port");
                await DropSession(sid, p, data.ip);
                return;
            }

            let changed = data.ip != currentIp;

            if (changed) {
                console.log("[+] Ip changed for Session ==> ", sid, " Updating ip");
                await DropSession(sid, p, data.ip);
                await UpdateSession(sid, p);
            }
        } else {
            console.log("[!] No data found for session ==> ", sid, " Update this session");
            let result = await UpdateSession(sid, p);
            if (result != null) {
                console.log("[+] Session ==> ", sid, " Updated successfully");
            } else {
                console.log("[!] Session ==> ", sid, " Update failed");
            }
        }
    } catch (error) {
        console.error(`[!] ProcessSession error for ${p._id}:${sid}`, error.message);
    }
}

// Process sessions with concurrency control
async function processBatch(proxies) {
    const tasks = [];
    
    // Create all tasks - limiter will queue and execute with concurrency control
    for (let p of proxies) {
        for (let sid = 0; sid < SESSION_COUNT; sid++) {
            tasks.push(limiter.execute(() => ProcessSession(p, sid)));
        }
    }
    
    // Wait for all tasks to complete (with concurrency limiting)
    await Promise.allSettled(tasks); // Use allSettled to continue even if some fail
}

// Main loop
while (true) {
    try {
        console.log(`[+] Starting processing cycle at ${new Date().toISOString()}`);
        const startTime = Date.now();
        
        await processBatch(proxies);
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[+] Processing cycle completed in ${duration}s`);
        
        await wait(LOOP_DELAY);
    } catch (error) {
        console.error("[!] Fatal error in main loop:", error);
        await wait(LOOP_DELAY);
    }
}