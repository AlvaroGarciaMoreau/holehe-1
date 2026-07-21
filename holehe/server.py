from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import webbrowser
import threading
import queue
import json
import os
import trio
import httpx

app = FastAPI(title="Holehe Dashboard")

# Habilitar CORS para peticiones desde el frontend de desarrollo local
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths for static assets
current_dir = os.path.dirname(os.path.abspath(__file__))
static_dir = os.path.join(current_dir, "dashboard")

# Route to serve the dashboard home page
@app.get("/")
async def get_dashboard():
    index_path = os.path.join(static_dir, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>Holehe Dashboard Static Assets Not Created Yet</h1>")

# Mount the static directory
# We will create this directory in the next steps
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/api/sites")
async def get_sites():
    """Returns a list of all sites that can be scanned with their categories."""
    from holehe.core import import_submodules, MODULES_DATA, get_functions
    modules = import_submodules("holehe.modules")
    websites = get_functions(modules)
    
    # Extract sites and their categories
    sites = []
    # Create mapping of function name to category
    for name, module in modules.items():
        if len(name.split(".")) > 3:
            site = name.split(".")[-1]
            category = name.split(".")[-2]
            domain = MODULES_DATA.get(site, f"{site}.com")
            sites.append({
                "name": site,
                "domain": domain,
                "category": category
            })
            
    # Sort sites by name
    sites = sorted(sites, key=lambda x: x["name"])
    return sites

async def execute_scan(email: str, no_password_recovery: bool, q: queue.Queue):
    """Executes the holehe scan asynchronously using Trio and sends results to the queue."""
    from holehe.core import import_submodules, get_functions, launch_module, MODULES_DATA
    
    modules = import_submodules("holehe.modules")
    
    class Args:
        nopasswordrecovery = no_password_recovery
        
    args = Args()
    websites = get_functions(modules, args)
    
    # Notify total websites to scan
    q.put({
        "type": "start",
        "total": len(websites)
    })
    
    # Create category mapping
    name_to_category = {}
    for name, module in modules.items():
        if len(name.split(".")) > 3:
            site = name.split(".")[-1]
            name_to_category[site] = name.split(".")[-2]

    # Callback list class to intercept appends
    class CallbackList(list):
        def __init__(self, callback):
            super().__init__()
            self.callback = callback
            
        def append(self, item):
            super().append(item)
            # Add category if available
            item_copy = item.copy()
            item_copy["category"] = name_to_category.get(item["name"], "other")
            self.callback(item_copy)
            
    def on_result(res):
        q.put({
            "type": "result",
            "data": res
        })
        
    out = CallbackList(on_result)
    client = httpx.AsyncClient(timeout=10)
    
    try:
        async with trio.open_nursery() as nursery:
            for website in websites:
                nursery.start_soon(launch_module, website, email, client, out)
    except Exception as e:
        q.put({
            "type": "error",
            "message": str(e)
        })
    finally:
        await client.aclose()

@app.get("/api/scan")
async def api_scan(email: str, no_password_recovery: bool = False):
    """Streams scan updates via Server-Sent Events (SSE)."""
    import anyio
    q = queue.Queue()
    
    def run_trio_loop():
        try:
            trio.run(execute_scan, email, no_password_recovery, q)
        except Exception as e:
            q.put({
                "type": "error",
                "message": f"Trio run error: {str(e)}"
            })
        finally:
            q.put({"type": "done"})
            
    # Start scan in a background thread
    threading.Thread(target=run_trio_loop, daemon=True).start()
    
    async def event_generator():
        while True:
            try:
                # Read result with 30-sec timeout asynchronously using AnyIO threadpool
                item = await anyio.to_thread.run_sync(lambda: q.get(timeout=30))
                yield f"data: {json.dumps(item)}\n\n"
                if item.get("type") in ("done", "error"):
                    break
            except queue.Empty:
                yield f"data: {json.dumps({'type': 'timeout'})}\n\n"
                break
                
    return StreamingResponse(event_generator(), media_type="text/event-stream")

def start_server(host: str = "127.0.0.1", port: int = 8080):
    """Starts the FastAPI/Uvicorn server and launches the browser."""
    print(f"[*] Starting Holehe Dashboard on http://{host}:{port}")
    
    # Dynamically open the web browser after a small delay
    def open_browser():
        try:
            webbrowser.open(f"http://{host}:{port}/")
        except Exception:
            pass
            
    threading.Timer(1.5, open_browser).start()
    uvicorn.run(app, host=host, port=port)
