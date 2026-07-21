// --- Holehe OSINT Dashboard Client Side Controller ---

document.addEventListener('DOMContentLoaded', () => {
    // --- State Variables ---
    let scanResults = [];
    let activeEventSource = null;
    let scanStartTime = null;
    let timerInterval = null;
    let categories = new Set();
    
    let activeTab = 'all'; // all, found, notfound, errors
    let searchQuery = '';
    let selectedCategory = 'all';

    // --- DOM Elements ---
    const scanForm = document.getElementById('scanForm');
    const emailInput = document.getElementById('emailInput');
    const noPasswordRecovery = document.getElementById('noPasswordRecovery');
    const startScanBtn = document.getElementById('startScanBtn');
    const connectionStatus = document.getElementById('connectionStatus');
    const statusDot = document.querySelector('.status-dot');

    // Progress Section
    const progressSection = document.getElementById('progressSection');
    const currentScanningTarget = document.getElementById('currentScanningTarget');
    const progressPercentage = document.getElementById('progressPercentage');
    const progressBarFill = document.getElementById('progressBarFill');
    const progressCount = document.getElementById('progressCount');
    const cancelScanBtn = document.getElementById('cancelScanBtn');

    // Metrics Card Values
    const metricFound = document.getElementById('metricFound');
    const metricChecked = document.getElementById('metricChecked');
    const metricErrors = document.getElementById('metricErrors');
    const metricDuration = document.getElementById('metricDuration');

    // Toolbar Filters
    const tabAll = document.getElementById('tabAll');
    const tabFound = document.getElementById('tabFound');
    const tabNotFound = document.getElementById('tabNotFound');
    const tabErrors = document.getElementById('tabErrors');
    const badgeAll = document.getElementById('badgeAll');
    const badgeFound = document.getElementById('badgeFound');
    const badgeNotFound = document.getElementById('badgeNotFound');
    const badgeErrors = document.getElementById('badgeErrors');

    const searchInput = document.getElementById('searchInput');
    const categoryFilter = document.getElementById('categoryFilter');
    const resultsInfoText = document.getElementById('resultsInfoText');
    const exportActions = document.getElementById('exportActions');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const exportJsonBtn = document.getElementById('exportJsonBtn');

    // Results Container & History
    const resultsGrid = document.getElementById('resultsGrid');
    const placeholderState = document.getElementById('placeholderState');
    const historyList = document.getElementById('historyList');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');

    // --- Setup Categories ---
    async function loadCategories() {
        try {
            const res = await fetch('/api/sites');
            if (res.ok) {
                const sites = await res.json();
                categories.clear();
                sites.forEach(s => {
                    if (s.category) categories.add(s.category);
                });
                
                // Populate category drop-down
                categoryFilter.innerHTML = '<option value="all">All Categories</option>';
                const sortedCategories = Array.from(categories).sort();
                sortedCategories.forEach(cat => {
                    const formattedCat = cat.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
                    categoryFilter.innerHTML += `<option value="${cat}">${formattedCat}</option>`;
                });
            }
        } catch (err) {
            console.error("Failed to load categories:", err);
        }
    }

    // --- Render Scan History ---
    function renderHistory() {
        const history = JSON.parse(localStorage.getItem('holehe_history') || '[]');
        if (history.length === 0) {
            historyList.innerHTML = `
                <div class="empty-history" id="emptyHistory">
                    <p>No recent scans yet.</p>
                </div>
            `;
            return;
        }

        historyList.innerHTML = '';
        history.forEach((scan, index) => {
            const date = new Date(scan.timestamp);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
            
            const historyItem = document.createElement('div');
            historyItem.className = 'history-item';
            historyItem.innerHTML = `
                <div class="history-item-header">
                    <span class="history-email" title="${scan.email}">${scan.email}</span>
                    <span class="history-badge">${scan.foundCount} Hits</span>
                </div>
                <div class="history-meta">
                    <span>${dateStr} @ ${timeStr}</span>
                    <span>${scan.totalChecked} Sites</span>
                </div>
                <button type="button" class="history-item-delete" data-index="${index}" aria-label="Delete History Item">
                    <i data-lucide="trash"></i>
                </button>
            `;
            
            historyItem.addEventListener('click', (e) => {
                if (e.target.closest('.history-item-delete')) return;
                loadScanFromHistory(scan);
                // Mark active
                document.querySelectorAll('.history-item').forEach(item => item.classList.remove('active'));
                historyItem.classList.add('active');
            });

            historyList.appendChild(historyItem);
        });

        // Setup delete buttons
        document.querySelectorAll('.history-item-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(btn.getAttribute('data-index'));
                deleteHistoryItem(index);
            });
        });
        
        lucide.createIcons();
    }

    function saveScanToHistory(email, results) {
        const history = JSON.parse(localStorage.getItem('holehe_history') || '[]');
        const foundCount = results.filter(r => r.exists).length;
        const scanEntry = {
            email,
            timestamp: Date.now(),
            results,
            foundCount,
            totalChecked: results.length
        };
        
        // Remove duplicates of same email to avoid clutter
        const filteredHistory = history.filter(h => h.email !== email);
        filteredHistory.unshift(scanEntry);
        
        // Keep last 15 items
        if (filteredHistory.length > 15) {
            filteredHistory.pop();
        }
        
        localStorage.setItem('holehe_history', JSON.stringify(filteredHistory));
        renderHistory();
    }

    function deleteHistoryItem(index) {
        let history = JSON.parse(localStorage.getItem('holehe_history') || '[]');
        history.splice(index, 1);
        localStorage.setItem('holehe_history', JSON.stringify(history));
        renderHistory();
    }

    function loadScanFromHistory(scan) {
        scanResults = scan.results;
        emailInput.value = scan.email;
        
        // Reset timers/progress display
        progressSection.classList.add('hidden');
        
        // Update metric display
        const found = scanResults.filter(r => r.exists).length;
        const errors = scanResults.filter(r => r.error || r.rateLimit).length;
        
        metricFound.textContent = found;
        metricChecked.textContent = `${scanResults.length} / ${scanResults.length}`;
        metricErrors.textContent = errors;
        metricDuration.textContent = "Saved";

        resultsInfoText.textContent = `Viewing results for scan: ${scan.email}`;
        exportActions.classList.remove('hidden');

        updateFilterBadges();
        filterAndRenderResults();
    }

    // --- Scan Initiation & Streaming ---
    function startScan(email) {
        if (activeEventSource) {
            activeEventSource.close();
        }

        // Reset variables
        scanResults = [];
        let totalSites = 0;
        let completedSites = 0;
        
        // Reset UI metrics
        metricFound.textContent = '0';
        metricChecked.textContent = '0 / 0';
        metricErrors.textContent = '0';
        metricDuration.textContent = '0s';
        
        resultsGrid.innerHTML = '';
        placeholderState.classList.add('hidden');
        progressSection.classList.remove('hidden');
        resultsInfoText.textContent = `Scanning email address: ${email}...`;
        exportActions.classList.add('hidden');

        // Status update
        statusDot.className = 'status-dot scanning';
        connectionStatus.textContent = 'Scanning...';
        startScanBtn.disabled = true;
        startScanBtn.querySelector('.btn-text').textContent = 'Scanning...';
        
        // Timer implementation
        scanStartTime = Date.now();
        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            const elapsed = Math.round((Date.now() - scanStartTime) / 1000);
            metricDuration.textContent = `${elapsed}s`;
        }, 1000);

        // SSE Setup
        const nopass = noPasswordRecovery.checked ? 'true' : 'false';
        const sseUrl = `/api/scan?email=${encodeURIComponent(email)}&no_password_recovery=${nopass}`;
        activeEventSource = new EventSource(sseUrl);

        activeEventSource.onmessage = (event) => {
            const eventData = JSON.parse(event.data);
            
            if (eventData.type === 'start') {
                totalSites = eventData.total;
                metricChecked.textContent = `0 / ${totalSites}`;
                progressCount.textContent = `0 / ${totalSites} platforms checked`;
                updateFilterBadges();
            }
            else if (eventData.type === 'result') {
                const res = eventData.data;
                
                // Guard against duplicate results for the same platform
                if (scanResults.some(r => r.name === res.name)) {
                    return;
                }
                
                scanResults.push(res);
                completedSites++;
                
                // Update live progress
                const percent = Math.round((completedSites / totalSites) * 100);
                progressBarFill.style.width = `${percent}%`;
                progressPercentage.textContent = `${percent}%`;
                progressCount.textContent = `${completedSites} / ${totalSites} platforms checked`;
                currentScanningTarget.textContent = res.domain;

                // Live update metric counts
                const foundCount = scanResults.filter(r => r.exists).length;
                const errorCount = scanResults.filter(r => r.error || r.rateLimit).length;
                metricFound.textContent = foundCount;
                metricChecked.textContent = `${completedSites} / ${totalSites}`;
                metricErrors.textContent = errorCount;

                // Dynamically render result if it matches active filters
                appendResultCard(res);
                updateFilterBadges();
            }
            else if (eventData.type === 'error') {
                activeEventSource.close();
                clearInterval(timerInterval);
                finishScan(true, eventData.message || 'An unknown error occurred');
            }
            else if (eventData.type === 'done') {
                activeEventSource.close();
                clearInterval(timerInterval);
                finishScan(false);
                saveScanToHistory(email, scanResults);
            }
        };

        activeEventSource.onerror = (err) => {
            console.error("SSE Error:", err);
            activeEventSource.close();
            clearInterval(timerInterval);
            finishScan(true, 'Lost connection to scanner daemon.');
        };
    }

    function finishScan(hasError, message = '') {
        statusDot.className = 'status-dot online';
        connectionStatus.textContent = 'Connected to Backend';
        startScanBtn.disabled = false;
        startScanBtn.querySelector('.btn-text').textContent = 'Start OSINT Scan';
        
        progressSection.classList.add('hidden');
        
        if (hasError) {
            resultsInfoText.textContent = `Scan failed: ${message}`;
            resultsGrid.innerHTML = `
                <div class="placeholder-state">
                    <div style="background: rgba(239, 68, 68, 0.12); color: var(--status-danger); width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-bottom: 16px;">
                        <i data-lucide="alert-octagon"></i>
                    </div>
                    <h3>Scan Error</h3>
                    <p>${message}</p>
                </div>
            `;
            lucide.createIcons();
        } else {
            const elapsed = Math.round((Date.now() - scanStartTime) / 1000);
            metricDuration.textContent = `${elapsed}s`;
            resultsInfoText.textContent = `Completed scan for: ${emailInput.value}`;
            exportActions.classList.remove('hidden');
            filterAndRenderResults();
        }
        activeEventSource = null;
    }

    function cancelScan() {
        if (activeEventSource) {
            activeEventSource.close();
            activeEventSource = null;
            clearInterval(timerInterval);
            finishScan(false);
            resultsInfoText.textContent = 'Scan cancelled by user.';
        }
    }

    // --- Results Rendering & Filtering ---
    function updateFilterBadges() {
        const found = scanResults.filter(r => r.exists).length;
        const notFound = scanResults.filter(r => !r.exists && !r.error && !r.rateLimit).length;
        const errors = scanResults.filter(r => r.error || r.rateLimit).length;

        badgeAll.textContent = scanResults.length;
        badgeFound.textContent = found;
        badgeNotFound.textContent = notFound;
        badgeErrors.textContent = errors;
    }

    function appendResultCard(res) {
        // Only append directly to UI grid if it passes the current tab/category/search filters
        if (!passesFilters(res)) return;
        
        // Remove placeholder if present
        const placeholder = document.getElementById('placeholderState');
        if (placeholder) placeholder.remove();

        const card = createCardElement(res);
        resultsGrid.appendChild(card);
    }

    function passesFilters(res) {
        // 1. Tab Status Filter
        if (activeTab === 'found' && !res.exists) return false;
        if (activeTab === 'notfound' && (res.exists || res.error || res.rateLimit)) return false;
        if (activeTab === 'errors' && !res.error && !res.rateLimit) return false;

        // 2. Search query filter
        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            const nameMatch = res.name.toLowerCase().includes(query);
            const domainMatch = res.domain.toLowerCase().includes(query);
            if (!nameMatch && !domainMatch) return false;
        }

        // 3. Category Filter
        if (selectedCategory !== 'all' && res.category !== selectedCategory) return false;

        return true;
    }

    function createCardElement(res) {
        const card = document.createElement('div');
        const isHit = res.exists;
        card.className = `result-card ${isHit ? 'exists-glowing' : ''}`;
        
        let statusText = 'Not Found';
        let badgeClass = 'not-exists';
        if (res.exists) {
            statusText = 'Registered';
            badgeClass = 'exists';
        } else if (res.rateLimit) {
            statusText = 'Rate Limited';
            badgeClass = 'ratelimit';
        } else if (res.error) {
            statusText = 'Error';
            badgeClass = 'error';
        }

        const monogram = res.name.substring(0, 2);
        
        let detailsHtml = '';
        if (res.emailrecovery || res.phoneNumber || res.others) {
            detailsHtml += `<div class="result-details">`;
            if (res.emailrecovery) {
                detailsHtml += `
                    <div class="detail-row">
                        <span class="detail-key">Recovery Mail</span>
                        <span class="detail-val">${res.emailrecovery}</span>
                    </div>
                `;
            }
            if (res.phoneNumber) {
                detailsHtml += `
                    <div class="detail-row">
                        <span class="detail-key">Recovery Phone</span>
                        <span class="detail-val">${res.phoneNumber}</span>
                    </div>
                `;
            }
            if (res.others) {
                Object.keys(res.others).forEach(key => {
                    detailsHtml += `
                        <div class="detail-row">
                            <span class="detail-key">${key}</span>
                            <span class="detail-val">${res.others[key]}</span>
                        </div>
                    `;
                });
            }
            detailsHtml += `</div>`;
        }

        const categoryText = res.category ? res.category.replace('_', ' ') : 'other';

        card.innerHTML = `
            <div class="result-card-header">
                <div class="result-card-meta">
                    <div class="result-avatar">
                        <span class="avatar-text">${monogram}</span>
                    </div>
                    <div class="result-card-title">
                        <span class="site-name">${res.name}</span>
                        <a href="https://${res.domain}" target="_blank" rel="noopener noreferrer" class="site-domain">${res.domain}</a>
                    </div>
                </div>
                <span class="result-status-badge ${badgeClass}">${statusText}</span>
            </div>
            
            ${detailsHtml}
            
            <div class="result-card-footer">
                <span class="category-tag">${categoryText}</span>
                <button type="button" class="copy-btn" title="Copy Details">
                    <i data-lucide="copy" style="width: 14px; height: 14px;"></i>
                </button>
            </div>
        `;

        // Add copy button logic
        const copyBtn = card.querySelector('.copy-btn');
        copyBtn.addEventListener('click', () => {
            let copyText = `Platform: ${res.name}\nDomain: ${res.domain}\nStatus: ${statusText}`;
            if (res.emailrecovery) copyText += `\nRecovery Mail: ${res.emailrecovery}`;
            if (res.phoneNumber) copyText += `\nRecovery Phone: ${res.phoneNumber}`;
            if (res.others) copyText += `\nMetadata: ${JSON.stringify(res.others)}`;
            
            navigator.clipboard.writeText(copyText).then(() => {
                copyBtn.innerHTML = '<i data-lucide="check" style="width: 14px; height: 14px; color: var(--accent-emerald);"></i>';
                lucide.createIcons();
                setTimeout(() => {
                    copyBtn.innerHTML = '<i data-lucide="copy" style="width: 14px; height: 14px;"></i>';
                    lucide.createIcons();
                }, 2000);
            });
        });

        return card;
    }

    function filterAndRenderResults() {
        resultsGrid.innerHTML = '';
        
        const filtered = scanResults.filter(passesFilters);
        
        if (filtered.length === 0) {
            resultsGrid.innerHTML = `
                <div class="placeholder-state" id="placeholderState">
                    <div class="placeholder-icon-glow">
                        <i data-lucide="filter" class="placeholder-icon"></i>
                    </div>
                    <h3>No Matching Results</h3>
                    <p>No platforms matched your active search query, status tab, or category filters.</p>
                </div>
            `;
        } else {
            filtered.forEach(res => {
                const card = createCardElement(res);
                resultsGrid.appendChild(card);
            });
        }
        lucide.createIcons();
    }

    // --- Tab Selection Setup ---
    function setupTabs() {
        const tabs = [
            { btn: tabAll, value: 'all' },
            { btn: tabFound, value: 'found' },
            { btn: tabNotFound, value: 'notfound' },
            { btn: tabErrors, value: 'errors' }
        ];

        tabs.forEach(t => {
            t.btn.addEventListener('click', () => {
                tabs.forEach(x => {
                    x.btn.classList.remove('active');
                    x.btn.setAttribute('aria-selected', 'false');
                });
                t.btn.classList.add('active');
                t.btn.setAttribute('aria-selected', 'true');
                activeTab = t.value;
                filterAndRenderResults();
            });
        });
    }

    // --- Export Utilities ---
    function exportToCsv() {
        if (scanResults.length === 0) return;
        
        const headers = ["name", "domain", "exists", "rateLimit", "error", "emailrecovery", "phoneNumber", "category", "others"];
        const rows = scanResults.map(res => {
            return [
                res.name,
                res.domain,
                res.exists,
                res.rateLimit,
                res.error || false,
                res.emailrecovery || "",
                res.phoneNumber || "",
                res.category || "",
                res.others ? JSON.stringify(res.others) : ""
            ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(",");
        });

        const csvContent = [headers.join(","), ...rows].join("\n");
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        
        const filename = `holehe_${emailInput.value.replace(/[^a-zA-Z0-9]/g, '_')}_results.csv`;
        link.setAttribute("href", url);
        link.setAttribute("download", filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function exportToJson() {
        if (scanResults.length === 0) return;
        
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(scanResults, null, 2));
        const link = document.createElement('a');
        const filename = `holehe_${emailInput.value.replace(/[^a-zA-Z0-9]/g, '_')}_results.json`;
        
        link.setAttribute("href", dataStr);
        link.setAttribute("download", filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // --- Global Event Bindings ---
    scanForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = emailInput.value.trim();
        if (email) {
            startScan(email);
        }
    });

    cancelScanBtn.addEventListener('click', cancelScan);

    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        filterAndRenderResults();
    });

    categoryFilter.addEventListener('change', (e) => {
        selectedCategory = e.target.value;
        filterAndRenderResults();
    });

    exportCsvBtn.addEventListener('click', exportToCsv);
    exportJsonBtn.addEventListener('click', exportToJson);

    clearHistoryBtn.addEventListener('click', () => {
        if (confirm("Are you sure you want to clear all saved scans from history?")) {
            localStorage.removeItem('holehe_history');
            renderHistory();
        }
    });

    // --- Initialize ---
    loadCategories();
    renderHistory();
    setupTabs();
});
