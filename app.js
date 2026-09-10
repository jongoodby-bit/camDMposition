/**
 * app.js — Главная логика веб-приложения CamDataM
 * Управление камерой iPhone/Android, видоискателем, инспекцией и UI
 */

let vision = null;
let isCvReady = false;

// DOM Elements
const video = document.getElementById('video');
const overlayCanvas = document.getElementById('overlayCanvas');
const capturedCanvas = document.getElementById('capturedCanvas');
const procCanvas = document.getElementById('procCanvas');
const zoomCanvas = document.getElementById('zoomCanvas');
const manualPreviewCanvas = document.getElementById('manualPreviewCanvas');

const btnCapture = document.getElementById('btnCapture');
const btnLeft = document.getElementById('btnLeft');
const btnTorch = document.getElementById('btnTorch');
const btnManual = document.getElementById('btnManual');
const btnZero = document.getElementById('btnZero');
const btnZoomView = document.getElementById('btnZoomView');
const btnRoiPlus = document.getElementById('btnRoiPlus');
const btnRoiMinus = document.getElementById('btnRoiMinus');
const tvRoiScale = document.getElementById('tvRoiScale');

const tvStatusText = document.getElementById('tvStatusText');
const mLeft = document.getElementById('mLeft');
const mRight = document.getElementById('mRight');
const mTop = document.getElementById('mTop');
const mBottom = document.getElementById('mBottom');
const mCodeSize = document.getElementById('mCodeSize');

// Modals
const settingsModal = document.getElementById('settingsModal');
const manualModal = document.getElementById('manualModal');
const zoomModal = document.getElementById('zoomModal');
const selFrameSize = document.getElementById('selFrameSize');
const btnSaveSettings = document.getElementById('btnSaveSettings');
const btnCloseZoom = document.getElementById('btnCloseZoom');

// Manual tuning sliders
const rngThresh = document.getElementById('rngThresh');
const rngBlur = document.getElementById('rngBlur');
const rngMorph = document.getElementById('rngMorph');
const chkSmart = document.getElementById('chkSmart');
const lblThresh = document.getElementById('lblThresh');
const lblBlur = document.getElementById('lblBlur');
const lblMorph = document.getElementById('lblMorph');
const lblLiveX = document.getElementById('lblLiveX');
const lblLiveY = document.getElementById('lblLiveY');
const btnAutoOtsu = document.getElementById('btnAutoOtsu');
const btnManualCancel = document.getElementById('btnManualCancel');
const btnManualApply = document.getElementById('btnManualApply');
const segOverlay = document.getElementById('segOverlay');
const segMask = document.getElementById('segMask');
const segWarp = document.getElementById('segWarp');

// State Variables (synced with LocalStorage)
let isCaptured = false;
let capturedRoiImageData = null;
let lastResult = null;
let lastWarpCanvas = null;

let frameSizeMm = parseFloat(localStorage.getItem('frameSizeMm') || '15.0');
let pThresh = parseInt(localStorage.getItem('pThresh') || '170');
let pBlur = parseInt(localStorage.getItem('pBlur') || '5');
let pMorph = parseInt(localStorage.getItem('pMorph') || '5');
let smartMode = localStorage.getItem('smartMode') !== 'false';
let roiScale = parseFloat(localStorage.getItem('roiScale') || '0.35');
let zeroOffsetX = parseFloat(localStorage.getItem('zeroOffsetX') || '0.0');
let zeroOffsetY = parseFloat(localStorage.getItem('zeroOffsetY') || '0.0');

let curManualViewMode = 'overlay'; // overlay | mask | warp
let isTorchOn = false;
let mediaStreamTrack = null;

// Accelerometer tilt state
let tiltAx = 0, tiltAy = 0;

function onOpenCvReady() {
    cv['onRuntimeInitialized'] = () => {
        isCvReady = true;
        vision = new VisionCore();
        const loadingEl = document.getElementById('cvLoading');
        if (loadingEl) loadingEl.style.display = 'none';
        console.log("OpenCV.js Ready!");
    };
}

// 1. Camera Initialization
async function initCamera() {
    try {
        const constraints = {
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        await video.play();

        const tracks = stream.getVideoTracks();
        if (tracks && tracks.length > 0) {
            mediaStreamTrack = tracks[0];
        }

        resizeCanvases();
        requestAnimationFrame(renderLoop);
    } catch (err) {
        alert("Не удалось получить доступ к камере: " + err.message);
    }
}

function resizeCanvases() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    overlayCanvas.width = w;
    overlayCanvas.height = h;
    capturedCanvas.width = w;
    capturedCanvas.height = h;
}

window.addEventListener('resize', resizeCanvases);

// 2. Torch control
async function toggleTorch() {
    if (!mediaStreamTrack) {
        alert("Фонарик недоступен на данном устройстве");
        return;
    }
    const capabilities = mediaStreamTrack.getCapabilities ? mediaStreamTrack.getCapabilities() : {};
    if (!capabilities.torch) {
        // Fallback for devices without standard torch API
        isTorchOn = !isTorchOn;
        btnTorch.classList.toggle('active', isTorchOn);
        return;
    }

    try {
        isTorchOn = !isTorchOn;
        await mediaStreamTrack.applyConstraints({
            advanced: [{ torch: isTorchOn }]
        });
        btnTorch.classList.toggle('active', isTorchOn);
    } catch (e) {
        console.log("Torch error:", e);
    }
}

// 3. Accelerometer (DeviceOrientation)
window.addEventListener('devicemotion', (event) => {
    if (event.accelerationIncludingGravity) {
        tiltAx = event.accelerationIncludingGravity.x || 0;
        tiltAy = event.accelerationIncludingGravity.y || 0;
    }
});

// 4. Viewfinder Rendering (Reticle & Spirit Level)
function renderLoop() {
    if (!isCaptured) {
        drawViewfinderOverlay();
    }
    requestAnimationFrame(renderLoop);
}

function drawViewfinderOverlay() {
    const ctx = overlayCanvas.getContext('2d');
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const side = Math.floor(Math.min(w, h) * roiScale);
    const rx = Math.floor((w - side) / 2);
    const ry = Math.floor((h - side) / 2);

    // Dimmed surround
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, w, ry);
    ctx.fillRect(0, ry + side, w, h - (ry + side));
    ctx.fillRect(0, ry, rx, side);
    ctx.fillRect(rx + side, ry, w - (rx + side), side);

    // Corner brackets
    const arm = Math.floor(side * 0.22);
    ctx.strokeStyle = '#00FF88';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';

    // Top-Left
    ctx.beginPath();
    ctx.moveTo(rx, ry + arm); ctx.lineTo(rx, ry); ctx.lineTo(rx + arm, ry);
    ctx.stroke();

    // Top-Right
    ctx.beginPath();
    ctx.moveTo(rx + side - arm, ry); ctx.lineTo(rx + side, ry); ctx.lineTo(rx + side, ry + arm);
    ctx.stroke();

    // Bottom-Right
    ctx.beginPath();
    ctx.moveTo(rx + side, ry + side - arm); ctx.lineTo(rx + side, ry + side); ctx.lineTo(rx + side - arm, ry + side);
    ctx.stroke();

    // Bottom-Left
    ctx.beginPath();
    ctx.moveTo(rx + arm, ry + side); ctx.lineTo(rx, ry + side); ctx.lineTo(rx, ry + side - arm);
    ctx.stroke();

    // Center Crosshair
    const cx = w / 2, cy = h / 2;
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 14, cy); ctx.lineTo(cx + 14, cy);
    ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy + 14);
    ctx.stroke();

    // Level bubble
    const bx = cx - (tiltAx * 4);
    const by = cy + (tiltAy * 4);
    ctx.strokeStyle = Math.hypot(tiltAx, tiltAy) < 1.0 ? '#00FF88' : '#FFEA00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, 6, 0, Math.PI * 2);
    ctx.stroke();
}

// 5. Capture & Analysis
function captureFrame() {
    if (!isCvReady) {
        alert("Ядро Vision еще загружается, подождите секунду...");
        return;
    }

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;

    procCanvas.width = vw;
    procCanvas.height = vh;
    const pCtx = procCanvas.getContext('2d');
    pCtx.drawImage(video, 0, 0, vw, vh);

    const side = Math.floor(Math.min(vw, vh) * roiScale);
    const rx = Math.floor((vw - side) / 2);
    const ry = Math.floor((vh - side) / 2);

    const roiCanvas = document.createElement('canvas');
    roiCanvas.width = side;
    roiCanvas.height = side;
    const rCtx = roiCanvas.getContext('2d');
    rCtx.drawImage(procCanvas, rx, ry, side, side, 0, 0, side, side);

    capturedRoiImageData = {
        fullCanvas: procCanvas,
        roiCanvas: roiCanvas,
        rx: rx,
        ry: ry,
        side: side,
        vw: vw,
        vh: vh
    };

    isCaptured = true;
    video.style.display = 'none';
    capturedCanvas.style.display = 'block';

    btnCapture.innerText = '🔄 СБРОС';
    btnCapture.classList.add('reset-state');
    btnLeft.innerText = '🔁 ПОВТОР';
    btnLeft.classList.add('repeat-state');
    btnManual.disabled = false;

    analyzeCurrentFrame();
}

function resetCapture() {
    isCaptured = false;
    capturedRoiImageData = null;
    lastResult = null;

    video.style.display = 'block';
    capturedCanvas.style.display = 'none';

    btnCapture.innerText = '📷 СНИМОК';
    btnCapture.classList.remove('reset-state');
    btnLeft.innerText = '⚙ НАСТРОЙКИ';
    btnLeft.classList.remove('repeat-state');
    btnManual.disabled = true;

    tvStatusText.innerText = zeroOffsetX !== 0 || zeroOffsetY !== 0
        ? 'Готов. (РЕЖИМ ЭТАЛОНА ВКЛЮЧЕН)'
        : 'НАВЕДИТЕ ПРИЦЕЛ НА ПОДЛОЖКУ И НАЖМИТЕ СНИМОК';

    mLeft.innerText = '—';
    mRight.innerText = '—';
    mTop.innerText = '—';
    mBottom.innerText = '—';
    mCodeSize.innerText = '—';

    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

function analyzeCurrentFrame() {
    if (!capturedRoiImageData) return;
    tvStatusText.innerText = '⏳ Анализ геометрии...';

    setTimeout(() => {
        const { roiCanvas, fullCanvas, rx, ry, side, vw, vh } = capturedRoiImageData;

        const roiMat = cv.imread(roiCanvas);
        const warpCanvas = document.createElement('canvas');
        warpCanvas.width = 500;
        warpCanvas.height = 500;

        const res = vision.process(roiMat, warpCanvas, frameSizeMm, pThresh, pBlur, pMorph, smartMode);
        lastResult = res;
        lastWarpCanvas = warpCanvas;

        roiMat.delete();

        displayResults(res, fullCanvas, rx, ry, side, vw, vh);
    }, 20);
}

function displayResults(res, fullCanvas, rx, ry, side, vw, vh) {
    const cCtx = capturedCanvas.getContext('2d');
    const cw = capturedCanvas.width;
    const ch = capturedCanvas.height;

    // Scale from video resolution to viewport
    const scaleX = cw / vw;
    const scaleY = ch / vh;
    const fitScale = Math.max(scaleX, scaleY);
    const offsetX = (cw - vw * fitScale) / 2;
    const offsetY = (ch - vh * fitScale) / 2;

    cCtx.clearRect(0, 0, cw, ch);
    cCtx.drawImage(fullCanvas, offsetX, offsetY, vw * fitScale, vh * fitScale);

    const relDx = res.dxMm - zeroOffsetX;
    const relDy = res.dyMm - zeroOffsetY;

    if (res.isSuccess && res.padPts) {
        // 1. Draw Green Pad Polygon
        const padScreen = res.padPts.map(p => ({
            x: (rx + p.x) * fitScale + offsetX,
            y: (ry + p.y) * fitScale + offsetY
        }));

        cCtx.strokeStyle = '#00FF88';
        cCtx.lineWidth = 3.5;
        cCtx.beginPath();
        cCtx.moveTo(padScreen[0].x, padScreen[0].y);
        for (let i = 1; i < padScreen.length; i++) cCtx.lineTo(padScreen[i].x, padScreen[i].y);
        cCtx.closePath();
        cCtx.stroke();

        const minPadX = Math.min(...padScreen.map(p => p.x));
        const maxPadX = Math.max(...padScreen.map(p => p.x));
        const minPadY = Math.min(...padScreen.map(p => p.y));
        const maxPadY = Math.max(...padScreen.map(p => p.y));
        const centerPadX = (minPadX + maxPadX) / 2.0;
        const centerPadY = (minPadY + maxPadY) / 2.0;

        if (res.codeBox) {
            // 2. Draw Code Box
            // Project 500x500 codeBox back to ROI
            const codeCenterROI = {
                x: (res.codeBox[0].x + res.codeBox[1].x + res.codeBox[2].x + res.codeBox[3].x) / 4.0,
                y: (res.codeBox[0].y + res.codeBox[1].y + res.codeBox[2].y + res.codeBox[3].y) / 4.0
            };

            // 3. Draw External Directional Arrows
            const yellowColor = '#FFEA00';
            const cyanColor = '#00E5FF';
            const greenColor = '#00E676';
            const badgeBg = 'rgba(24, 24, 32, 0.9)';

            // X-Axis (Horizontal)
            const arrowSpan = 60;
            const xArrowY = Math.max(35, minPadY - 35);
            if (Math.abs(relDx) >= 0.01) {
                const startX = relDx > 0 ? centerPadX + arrowSpan : centerPadX - arrowSpan;
                const endX = relDx > 0 ? centerPadX - arrowSpan : centerPadX + arrowSpan;
                drawVectorArrow(cCtx, startX, xArrowY, endX, xArrowY, yellowColor, 5);
                drawBadge(cCtx, `X: ${relDx > 0 ? 'ВЛЕВО' : 'ВПРАВО'} ${Math.abs(relDx).toFixed(2)} мм`, centerPadX, xArrowY - 24, yellowColor, badgeBg);
            } else {
                drawBadge(cCtx, 'X: 0.00 мм (ОК)', centerPadX, xArrowY - 10, greenColor, badgeBg);
            }

            // Y-Axis (Vertical)
            const yArrowX = Math.min(cw - 40, maxPadX + 35);
            if (Math.abs(relDy) >= 0.01) {
                const startY = relDy > 0 ? centerPadY + arrowSpan : centerPadY - arrowSpan;
                const endY = relDy > 0 ? centerPadY - arrowSpan : centerPadY + arrowSpan;
                drawVectorArrow(cCtx, yArrowX, startY, yArrowX, endY, cyanColor, 5);
                drawBadge(cCtx, `Y: ${relDy > 0 ? 'ВВЕРХ' : 'ВНИЗ'} ${Math.abs(relDy).toFixed(2)} мм`, Math.min(cw - 75, yArrowX + 65), centerPadY, cyanColor, badgeBg);
            } else {
                drawBadge(cCtx, 'Y: 0.00 мм (ОК)', Math.min(cw - 75, yArrowX + 65), centerPadY, greenColor, badgeBg);
            }

            // Metrics Update
            mLeft.innerText = res.distLeftMm.toFixed(2);
            mRight.innerText = res.distRightMm.toFixed(2);
            mTop.innerText = res.distTopMm.toFixed(2);
            mBottom.innerText = res.distBottomMm.toFixed(2);
            mCodeSize.innerText = `${res.codeWMm.toFixed(2)}x${res.codeHMm.toFixed(2)}`;

            const xRec = Math.abs(relDx) < 0.01 ? "0.00мм" : (relDx > 0 ? `ВЛЕВО ${Math.abs(relDx).toFixed(2)}мм` : `ВПРАВО ${Math.abs(relDx).toFixed(2)}мм`);
            const yRec = Math.abs(relDy) < 0.01 ? "0.00мм" : (relDy > 0 ? `ВВЕРХ ${Math.abs(relDy).toFixed(2)}мм` : `ВНИЗ ${Math.abs(relDy).toFixed(2)}мм`);
            tvStatusText.innerText = `ОСЬ X: ${xRec}  |  ОСЬ Y: ${yRec}`;
        } else {
            tvStatusText.innerText = res.statusText;
        }
    } else {
        tvStatusText.innerText = res.statusText;
    }
}

function drawVectorArrow(ctx, fromX, fromY, toX, toY, color, width) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    const angle = Math.atan2(toY - fromY, toX - fromX);
    const headLen = width * 3.5;
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLen * Math.cos(angle - Math.PI / 6), toY - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(toX - headLen * Math.cos(angle + Math.PI / 6), toY - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function drawBadge(ctx, text, x, y, textColor, bgColor) {
    ctx.save();
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const textWidth = ctx.measureText(text).width;

    ctx.fillStyle = bgColor;
    ctx.strokeStyle = textColor;
    ctx.lineWidth = 1.5;

    const padX = 8, padY = 4;
    const rx = x - textWidth / 2 - padX;
    const ry = y - 10 - padY;
    const rw = textWidth + padX * 2;
    const rh = 18 + padY * 2;

    ctx.beginPath();
    ctx.roundRect(rx, ry, rw, rh, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.fillText(text, x, y + 4);
    ctx.restore();
}

// 6. Manual Tuning Modal
function openManualModal() {
    if (!capturedRoiImageData) return;
    rngThresh.value = pThresh;
    rngBlur.value = pBlur;
    rngMorph.value = pMorph;
    chkSmart.checked = smartMode;

    updateManualLabels();
    updateManualPreview();
    manualModal.style.display = 'flex';
}

function updateManualLabels() {
    lblThresh.innerText = `Порог белого: ${rngThresh.value}`;
    lblBlur.innerText = `Гаусс: ${rngBlur.value}`;
    lblMorph.innerText = `Морфология: ${rngMorph.value}`;
}

function updateManualPreview() {
    if (!capturedRoiImageData) return;
    updateManualLabels();

    const curT = parseInt(rngThresh.value);
    const curB = parseInt(rngBlur.value);
    const curM = parseInt(rngMorph.value);
    const curS = chkSmart.checked;

    const { roiCanvas } = capturedRoiImageData;
    const roiMat = cv.imread(roiCanvas);
    const warpCanvas = document.createElement('canvas');
    warpCanvas.width = 500;
    warpCanvas.height = 500;

    const res = vision.process(roiMat, warpCanvas, frameSizeMm, curT, curB, curM, curS);

    if (res.isSuccess && res.codeBox) {
        lblLiveX.innerText = `X: Слева: ${res.distLeftMm.toFixed(2)} мм • Справа: ${res.distRightMm.toFixed(2)} мм`;
        lblLiveY.innerText = `Y: Сверху: ${res.distTopMm.toFixed(2)} мм • Снизу: ${res.distBottomMm.toFixed(2)} мм`;
    } else {
        lblLiveX.innerText = res.statusText;
        lblLiveY.innerText = '';
    }

    manualPreviewCanvas.width = roiCanvas.width;
    manualPreviewCanvas.height = roiCanvas.height;
    const pCtx = manualPreviewCanvas.getContext('2d');

    if (curManualViewMode === 'overlay') {
        pCtx.drawImage(roiCanvas, 0, 0);
        if (res.padPts) {
            pCtx.strokeStyle = '#00FF88';
            pCtx.lineWidth = 2.5;
            pCtx.beginPath();
            pCtx.moveTo(res.padPts[0].x, res.padPts[0].y);
            for (let i = 1; i < res.padPts.length; i++) pCtx.lineTo(res.padPts[i].x, res.padPts[i].y);
            pCtx.closePath();
            pCtx.stroke();
        }
    } else if (curManualViewMode === 'mask') {
        if (res.threshMat) {
            cv.imshow(manualPreviewCanvas, res.threshMat);
        }
    } else if (curManualViewMode === 'warp') {
        manualPreviewCanvas.width = 500;
        manualPreviewCanvas.height = 500;
        pCtx.drawImage(warpCanvas, 0, 0);
    }

    if (res.threshMat) res.threshMat.delete();
    roiMat.delete();
}

// 7. Event Listeners
btnCapture.addEventListener('click', () => {
    if (!isCaptured) captureFrame();
    else resetCapture();
});

btnLeft.addEventListener('click', () => {
    if (isCaptured) analyzeCurrentFrame();
    else {
        selFrameSize.value = frameSizeMm.toString();
        settingsModal.style.display = 'flex';
    }
});

btnManual.addEventListener('click', openManualModal);

btnZero.addEventListener('click', () => {
    if (zeroOffsetX !== 0 || zeroOffsetY !== 0) {
        zeroOffsetX = 0;
        zeroOffsetY = 0;
        localStorage.setItem('zeroOffsetX', '0');
        localStorage.setItem('zeroOffsetY', '0');
        btnZero.classList.remove('zero-active');
        tvStatusText.innerText = '🔄 БАЗА СБРОШЕНА (ЦЕНТР)';
        if (isCaptured) analyzeCurrentFrame();
    } else {
        if (isCaptured && lastResult && lastResult.isSuccess && lastResult.codeBox) {
            zeroOffsetX = lastResult.dxMm;
            zeroOffsetY = lastResult.dyMm;
            localStorage.setItem('zeroOffsetX', zeroOffsetX.toString());
            localStorage.setItem('zeroOffsetY', zeroOffsetY.toString());
            btnZero.classList.add('zero-active');
            tvStatusText.innerText = '✅ НОВАЯ БАЗА СОХРАНЕНА';
            analyzeCurrentFrame();
        }
    }
});

btnTorch.addEventListener('click', toggleTorch);

btnRoiPlus.addEventListener('click', () => {
    if (roiScale < 0.80) {
        roiScale = Math.min(0.80, roiScale + 0.05);
        tvRoiScale.innerText = `${Math.round(roiScale * 100)}%`;
        localStorage.setItem('roiScale', roiScale.toString());
    }
});

btnRoiMinus.addEventListener('click', () => {
    if (roiScale > 0.15) {
        roiScale = Math.max(0.15, roiScale - 0.05);
        tvRoiScale.innerText = `${Math.round(roiScale * 100)}%`;
        localStorage.setItem('roiScale', roiScale.toString());
    }
});

btnZoomView.addEventListener('click', () => {
    if (lastWarpCanvas) {
        zoomCanvas.width = 500;
        zoomCanvas.height = 500;
        const zCtx = zoomCanvas.getContext('2d');
        zCtx.drawImage(lastWarpCanvas, 0, 0);
        zoomModal.style.display = 'flex';
    } else {
        alert("Сначала сделайте снимок для просмотра зума!");
    }
});

btnCloseZoom.addEventListener('click', () => {
    zoomModal.style.display = 'none';
});

// Settings Modal
btnSaveSettings.addEventListener('click', () => {
    frameSizeMm = parseFloat(selFrameSize.value);
    localStorage.setItem('frameSizeMm', frameSizeMm.toString());
    settingsModal.style.display = 'none';
    if (isCaptured) analyzeCurrentFrame();
});

// Manual Tuning Listeners
[rngThresh, rngBlur, rngMorph].forEach(el => el.addEventListener('input', updateManualPreview));
chkSmart.addEventListener('change', updateManualPreview);

segOverlay.addEventListener('click', () => {
    curManualViewMode = 'overlay';
    segOverlay.classList.add('active');
    segMask.classList.remove('active');
    segWarp.classList.remove('active');
    updateManualPreview();
});

segMask.addEventListener('click', () => {
    curManualViewMode = 'mask';
    segMask.classList.add('active');
    segOverlay.classList.remove('active');
    segWarp.classList.remove('active');
    updateManualPreview();
});

segWarp.addEventListener('click', () => {
    curManualViewMode = 'warp';
    segWarp.classList.add('active');
    segOverlay.classList.remove('active');
    segMask.classList.remove('active');
    updateManualPreview();
});

btnAutoOtsu.addEventListener('click', () => {
    if (!capturedRoiImageData) return;
    const { roiCanvas } = capturedRoiImageData;
    const roiMat = cv.imread(roiCanvas);
    const grayMat = new cv.Mat();
    cv.cvtColor(roiMat, grayMat, cv.COLOR_RGBA2GRAY);

    const thresh = new cv.Mat();
    const otsuVal = cv.threshold(grayMat, thresh, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

    roiMat.delete();
    grayMat.delete();
    thresh.delete();

    rngThresh.value = Math.max(20, Math.min(245, Math.floor(otsuVal)));
    updateManualPreview();
});

btnManualCancel.addEventListener('click', () => {
    manualModal.style.display = 'none';
});

btnManualApply.addEventListener('click', () => {
    pThresh = parseInt(rngThresh.value);
    pBlur = parseInt(rngBlur.value);
    pMorph = parseInt(rngMorph.value);
    smartMode = chkSmart.checked;

    localStorage.setItem('pThresh', pThresh.toString());
    localStorage.setItem('pBlur', pBlur.toString());
    localStorage.setItem('pMorph', pMorph.toString());
    localStorage.setItem('smartMode', smartMode.toString());

    manualModal.style.display = 'none';
    if (isCaptured) analyzeCurrentFrame();
});

// Start camera on load
window.addEventListener('DOMContentLoaded', () => {
    tvRoiScale.innerText = `${Math.round(roiScale * 100)}%`;
    if (zeroOffsetX !== 0 || zeroOffsetY !== 0) {
        btnZero.classList.add('zero-active');
        tvStatusText.innerText = 'Готов. (РЕЖИМ ЭТАЛОНА ВКЛЮЧЕН)';
    }
    initCamera();
});
