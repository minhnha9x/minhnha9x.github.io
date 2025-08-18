// Configuration
const API_KEY = "QGG-35Z-ER6-IAD-UC7-R6N-9VP-5KS";
const WEBHOOK_API_KEY = "ea7cpff1-398a-41df-8539-5e1432n838f0";
const API_URL = "https://api.ifreeicloud.co.uk";
const SUPPORTED_SERVICE_CODES = ["MDM"];

const SERVICES = {
    0: { name: "Free Check", price: 0 },
    281: { name: "All-in-one (iFreeCheck Ultimate)", price: 25000 }
};

// Memory cache
const memoryCache = new Map();

// Custom error classes
class APIError extends Error {
    constructor(message) {
        super(message);
        this.name = 'APIError';
    }
}

class NetworkError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NetworkError';
    }
}

class ValidationError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = statusCode;
    }
}

// CORS configuration
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400', // 24 hours
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Handle CORS preflight requests
        if (request.method === 'OPTIONS') {
            return handleCORS();
        }

        let response;

        if (url.pathname === "/api/check" && request.method === "POST") {
            response = await checkDevice(request, env);
        } else if (url.pathname === "/hooks/sepay-payment" && request.method === "POST") {
            response = await handlePaymentHook(request, env);
        } else {
            response = new Response("Not Found", { status: 404 });
        }

        // Add CORS headers to all responses
        return addCORSHeaders(response);
    },
};

// CORS helper functions
function handleCORS() {
    return new Response(null, {
        status: 200,
        headers: CORS_HEADERS
    });
}

function addCORSHeaders(response) {
    // Clone the response to modify headers
    const newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
            ...Object.fromEntries(response.headers),
            ...CORS_HEADERS
        }
    });
    
    return newResponse;
}

async function handlePaymentHook(request, env) {
    const paymentData = await request.json();
    console.log("Payment webhook data:", JSON.stringify(paymentData));
    
    // Authenticate
    if (!isValidApiKey(request)) {
        console.error("Invalid API key");
        return new Response("Unauthorized", { status: 401 });
    }
    
    // Validate payment code
    if (!isValidPaymentCode(paymentData.code)) {
        console.error("Invalid payment code pattern:", paymentData.code);
        return new Response("OK", { status: 200 });
    }
    
    // Check for duplicates
    const existingPayment = await env.mdm_kv.get(paymentData.code);
    if (existingPayment) {
        console.error("Duplicate payment:", paymentData.code);
        return new Response("OK", { status: 200 });
    }
    
    // Save payment
    try {
        await env.mdm_kv.put(paymentData.code, JSON.stringify(paymentData));
        console.log("Payment saved successfully:", paymentData.code);
    } catch (error) {
        console.error("Failed to save payment:", error);
    }
    
    return new Response("OK", { status: 200 });
}

async function checkDevice(request, env) {
    try {
        const { imei, service = 0, transfer_code } = await request.json();
        
        // Validate input
        validateDeviceRequest(imei, transfer_code, service);

        const servicePrice = SERVICES[service].price;
        const isFreeService = servicePrice === 0;

        if (isFreeService) {
            return await handleFreeService(imei, service, env);
        } else {
            return await handlePaidService(imei, service, transfer_code, env);
        }
        
    } catch (error) {
        return handleError(error);
    }
}

async function handleFreeService(imei, service, env) {
    console.log(`Free service request - IMEI: ${imei}, Service: ${service}`);
    
    const result = await getDeviceData(`${imei}_${service}`, imei, service, env);
    
    return Response.json({
        success: true,
        data: result.data
    });
}

async function handlePaidService(imei, service, transfer_code, env) {
    // Validate payment
    await validatePayment(transfer_code, service, env);

    // Acquire lock first (atomic operation)
    if (!await acquireLock(transfer_code, env)) {
        return Response.json({ 
            error: "Transfer code is being processed by another request" 
        }, { status: 409 });
    }

    try {
        // Check if already used (after acquiring lock)
        if (await isTransferCodeUsed(transfer_code, env)) {
            throw new ValidationError("Transfer code already used");
        }

        // Get device data
        const result = await getDeviceData(`${imei}_${service}`, imei, service, env);
        
        // Mark as used
        await markTransferCodeAsUsed(transfer_code, imei, service, env);
        
        console.log(`IMEI: ${imei}, Service: ${service}, Source: ${result.source}, Transfer Code: ${transfer_code}`);
        
        return Response.json({
            success: true,
            data: result.data
        });
        
    } catch (error) {
        await releaseLock(transfer_code, env);
        throw error;
    }
}

function handleError(error) {
    console.error("Check device error:", error);
    
    if (error instanceof APIError) {
        return Response.json({ error: error.message }, { status: 400 });
    }
    
    if (error instanceof ValidationError) {
        return Response.json({ error: error.message }, { status: error.statusCode });
    }
    
    return Response.json({ 
        error: error.message || "Internal server error" 
    }, { status: 500 });
}

// Authentication
function isValidApiKey(request) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Apikey ")) {
        return false;
    }
    
    const providedApiKey = authHeader.replace("Apikey ", "");
    return providedApiKey === WEBHOOK_API_KEY;
}

// Validation functions
function isValidPaymentCode(code) {
    if (!code) return false;
    
    const pattern = /^([A-Za-z]{3})(\d{8})([A-Za-z0-9]{4})$/;
    if (!pattern.test(code)) return false;
    
    const serviceCode = code.substring(0, 3).toUpperCase();
    return SUPPORTED_SERVICE_CODES.includes(serviceCode);
}

function validateDeviceRequest(imei, transfer_code, service) {
    if (!imei) {
        throw new ValidationError("IMEI is required");
    }

    if (!SERVICES[service]) {
        throw new ValidationError("Service not supported");
    }

    const servicePrice = SERVICES[service].price;
    const isFreeService = servicePrice === 0;
    
    // Only require transfer_code for paid services
    if (!isFreeService && !transfer_code) {
        throw new ValidationError("Transfer code is required for paid services");
    }
}

// Lock management
async function acquireLock(transfer_code, env) {
    try {
        await env.DB.prepare(`
            INSERT INTO payment_locks (transfer_code, created_at) 
            VALUES (?, ?)
        `).bind(transfer_code, Date.now()).run();
        
        console.log("Lock acquired for:", transfer_code);
        return true;
        
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed') || 
            error.message.includes('already exists')) {
            return false;
        }
        throw error;
    }
}

async function releaseLock(transfer_code, env) {
    try {
        await env.DB.prepare(`
            DELETE FROM payment_locks WHERE transfer_code = ?
        `).bind(transfer_code).run();
        
        console.log("Lock released for retry:", transfer_code);
    } catch (error) {
        console.error("Failed to release lock:", error);
    }
}

// Payment validation
async function isTransferCodeUsed(transfer_code, env) {
    const usageKey = `used_${transfer_code}`;
    const usageRecord = await env.mdm_kv.get(usageKey);
    return !!usageRecord;
}

async function validatePayment(transfer_code, service, env) {
    const paymentRecord = await env.mdm_kv.get(transfer_code);
    if (!paymentRecord) {
        throw new ValidationError("Invalid transfer code or payment not found");
    }
    
    const payment = JSON.parse(paymentRecord);
    const servicePrice = SERVICES[service].price;
    
    if (payment.transferAmount < servicePrice) {
        throw new ValidationError("Payment amount insufficient for this service");
    }
}

async function markTransferCodeAsUsed(transfer_code, imei, service, env) {
    const usageKey = `used_${transfer_code}`;
    const usageData = {
        used_at: new Date().toISOString(),
        used_for_imei: imei,
        used_for_service: service,
        original_payment_key: transfer_code
    };
    
    await env.mdm_kv.put(usageKey, JSON.stringify(usageData));
}

// Device data retrieval
async function getDeviceData(cacheKey, imei, service, env) {
    // Try memory cache
    const memoryData = memoryCache.get(cacheKey);
    if (memoryData) {
        console.log("getDeviceData from memory", cacheKey);
        return { data: memoryData, source: "memory" };
    }
    
    // Try KV cache
    const kvData = await getFromKV(cacheKey, env);
    if (kvData) {
        memoryCache.set(cacheKey, kvData);
        console.log("getDeviceData from KV", cacheKey);
        return { data: kvData, source: "kv" };
    }
    
    // Call external API
    const apiData = await callAPI(imei, service);
    memoryCache.set(cacheKey, apiData);
    await saveToKV(cacheKey, apiData, env);
    console.log("getDeviceData from API", cacheKey);
    return { data: apiData, source: "api" };
}

async function getFromKV(cacheKey, env) {
    try {
        const cached = await env.mdm_kv.get(cacheKey);
        return cached ? JSON.parse(cached) : null;
    } catch (error) {
        console.error("KV read error:", error);
        return null;
    }
}

async function saveToKV(cacheKey, data, env) {
    try {
        await env.mdm_kv.put(cacheKey, JSON.stringify(data));
    } catch (error) {
        console.error("KV write error:", error);
    }
}

async function callAPI(imei, service) {
    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ service, imei, key: API_KEY })
        });

        if (!response.ok) {
            throw new NetworkError(`HTTP ${response.status}: API service unavailable`);
        }

        const result = await response.json();

        if (!result.success) {
            throw new APIError(result.error || "Invalid request");
        }

        return result.object;
        
    } catch (error) {
        if (error instanceof TypeError || error.name === 'TypeError') {
            throw new NetworkError("Network connection failed");
        }
        throw error;
    }
}