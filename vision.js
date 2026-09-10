/**
 * vision.js — Интеллектуальное ядро инспекции геометрического смещения DataMatrix
 * Точный порт scr_.py / GeometricOptimizer.kt на OpenCV.js и ZXing
 */

class VisionCore {
    constructor() {
        this.WARP_SIZE = 500;
        this.zxingReader = null;
        if (typeof ZXing !== 'undefined' && ZXing.BrowserMultiFormatReader) {
            const hints = new Map();
            hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.DATA_MATRIX]);
            hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
            this.zxingReader = new ZXing.BrowserMultiFormatReader(hints);
        }
    }

    /**
     * Сортирует 4 точки четырехугольника: [0: TL, 1: TR, 2: BR, 3: BL]
     */
    orderPoints(pts) {
        if (!pts || pts.length < 4) return pts;
        const flat = pts.slice(0, 4);

        const sums = flat.map(p => p.x + p.y);
        const diffs = flat.map(p => p.x - p.y);

        let minSumIdx = 0, maxSumIdx = 0, minDiffIdx = 0, maxDiffIdx = 0;
        let minSum = sums[0], maxSum = sums[0], minDiff = diffs[0], maxDiff = diffs[0];

        for (let i = 1; i < 4; i++) {
            if (sums[i] < minSum) { minSum = sums[i]; minSumIdx = i; }
            if (sums[i] > maxSum) { maxSum = sums[i]; maxSumIdx = i; }
            if (diffs[i] < minDiff) { minDiff = diffs[i]; minDiffIdx = i; }
            if (diffs[i] > maxDiff) { maxDiff = diffs[i]; maxDiffIdx = i; }
        }

        return [
            flat[minSumIdx],  // Top-Left
            flat[maxDiffIdx], // Top-Right
            flat[maxSumIdx],  // Bottom-Right
            flat[minDiffIdx]  // Bottom-Left
        ];
    }

    /**
     * Поиск DataMatrix через ZXing
     */
    detectDataMatrixZXing(canvas) {
        if (!this.zxingReader) return null;
        try {
            const res = this.zxingReader.decodeFromCanvas(canvas);
            if (res && res.resultPoints) {
                const rp = res.resultPoints;
                if (rp.length >= 4) {
                    return [
                        { x: rp[0].x, y: rp[0].y },
                        { x: rp[1].x, y: rp[1].y },
                        { x: rp[2].x, y: rp[2].y },
                        { x: rp[3].x, y: rp[3].y }
                    ];
                } else if (rp.length === 3) {
                    const p0 = rp[0], p1 = rp[1], p2 = rp[2];
                    const p3x = p0.x + (p2.x - p1.x);
                    const p3y = p0.y + (p2.y - p1.y);
                    return [
                        { x: p0.x, y: p0.y },
                        { x: p1.x, y: p1.y },
                        { x: p2.x, y: p2.y },
                        { x: p3x, y: p3y }
                    ];
                }
            }
        } catch (e) {
            // barcode not detected in this frame
        }
        return null;
    }

    /**
     * Контурный fallback поиск DataMatrix
     */
    detectDataMatrixContour(grayMat) {
        const w = grayMat.cols;
        const h = grayMat.rows;
        const totalArea = w * h;
        const centerCanvas = { x: w / 2.0, y: h / 2.0 };

        const thresh = new cv.Mat();
        cv.threshold(grayMat, thresh, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);

        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
        const closed = new cv.Mat();
        cv.morphologyEx(thresh, closed, cv.MORPH_CLOSE, kernel);

        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        let bestScore = -1.0;
        let bestBox = null;

        for (let i = 0; i < contours.size(); ++i) {
            const cnt = contours.get(i);
            const area = cv.contourArea(cnt);
            if (area > totalArea * 0.002 && area < totalArea * 0.85) {
                const rect = cv.minAreaRect(cnt);
                const rw = rect.size.width;
                const rh = rect.size.height;
                if (rw > 6 && rh > 6) {
                    const aspect = Math.min(rw, rh) / Math.max(rw, rh);
                    if (aspect >= 0.40) {
                        const distNorm = Math.hypot(rect.center.x - centerCanvas.x, rect.center.y - centerCanvas.y) / (Math.hypot(w, h) / 2.0);
                        const score = area * aspect * (1.0 - 0.35 * distNorm);
                        if (score > bestScore) {
                            bestScore = score;
                            const ptsMat = cv.RotatedRect.points(rect);
                            bestBox = this.orderPoints(ptsMat);
                        }
                    }
                }
            }
            cnt.delete();
        }

        thresh.delete();
        kernel.delete();
        closed.delete();
        hierarchy.delete();
        contours.delete();

        return bestBox;
    }

    findDataMatrixAny(grayMat, canvas) {
        let pts = null;
        if (canvas) {
            pts = this.detectDataMatrixZXing(canvas);
        }
        if (!pts) {
            pts = this.detectDataMatrixContour(grayMat);
        }
        return pts;
    }

    /**
     * Smart Raycast: поиск границ подложки от DataMatrix наружу
     */
    detectSmartPad(grayMat, canvas, minDrop = 2.5) {
        const w = grayMat.cols;
        const h = grayMat.rows;

        const dmPts = this.findDataMatrixAny(grayMat, canvas);
        if (!dmPts) return { padPts: null, dmPts: null };

        const orderedDm = this.orderPoints(dmPts);
        const cx = (orderedDm[0].x + orderedDm[1].x + orderedDm[2].x + orderedDm[3].x) / 4.0;
        const cy = (orderedDm[0].y + orderedDm[1].y + orderedDm[2].y + orderedDm[3].y) / 4.0;

        const dx = orderedDm[1].x - orderedDm[0].x;
        const dy = orderedDm[1].y - orderedDm[0].y;
        const angleDeg = (Math.atan2(dy, dx) * 180.0) / Math.PI;

        const centerPoint = new cv.Point(cx, cy);
        const mRot = cv.getRotationMatrix2D(centerPoint, angleDeg, 1.0);
        const mRotInv = cv.getRotationMatrix2D(centerPoint, -angleDeg, 1.0);

        const alignedDm = orderedDm.map(pt => {
            const rx = mRot.doubleAt(0, 0) * pt.x + mRot.doubleAt(0, 1) * pt.y + mRot.doubleAt(0, 2);
            const ry = mRot.doubleAt(1, 0) * pt.x + mRot.doubleAt(1, 1) * pt.y + mRot.doubleAt(1, 2);
            return { x: rx, y: ry };
        });

        const dmMinX = Math.min(...alignedDm.map(p => p.x));
        const dmMaxX = Math.max(...alignedDm.map(p => p.x));
        const dmMinY = Math.min(...alignedDm.map(p => p.y));
        const dmMaxY = Math.max(...alignedDm.map(p => p.y));

        const dmW = dmMaxX - dmMinX;
        const dmH = dmMaxY - dmMinY;
        const dmSize = (dmW + dmH) / 2.0;

        if (dmSize < 10.0) {
            mRot.delete();
            mRotInv.delete();
            return { padPts: null, dmPts: orderedDm };
        }

        const alignedGray = new cv.Mat();
        cv.warpAffine(grayMat, alignedGray, mRot, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

        const smooth = new cv.Mat();
        cv.bilateralFilter(alignedGray, smooth, 9, 50.0, 50.0);

        const smoothData = smooth.data;
        function getPix(x, y) {
            const cxClamped = Math.max(0, Math.min(w - 1, Math.floor(x)));
            const cyClamped = Math.max(0, Math.min(h - 1, Math.floor(y)));
            return smoothData[cyClamped * w + cxClamped];
        }

        const alCx = (dmMinX + dmMaxX) / 2.0;
        const alCy = (dmMinY + dmMaxY) / 2.0;
        const spanX = Math.max(5, Math.floor(dmW * 0.35));
        const spanY = Math.max(5, Math.floor(dmH * 0.35));
        const xsStart = Math.max(0, Math.floor(alCx - spanX));
        const xsEnd = Math.min(w - 1, Math.floor(alCx + spanX));
        const ysStart = Math.max(0, Math.floor(alCy - spanY));
        const ysEnd = Math.min(h - 1, Math.floor(alCy + spanY));

        const qz = Math.max(4, Math.floor(dmSize * 0.05));

        function findFirstDrop(profile, minThresh) {
            for (const threshold of [minThresh, 1.8, 1.2]) {
                let bestCoord = null;
                let bestDrop = 0;
                let inPeak = false;
                for (const item of profile) {
                    if (item.d >= threshold) {
                        if (!inPeak || item.d > bestDrop) {
                            bestDrop = item.d;
                            bestCoord = item.coord;
                            inPeak = true;
                        }
                    } else if (inPeak) {
                        break;
                    }
                }
                if (bestCoord !== null) return bestCoord;
            }
            return null;
        }

        // Top profile
        const topProf = [];
        const topLimit = Math.max(2, Math.floor(alCy - dmSize * 1.8));
        for (let y = Math.floor(dmMinY - qz); y >= topLimit; y--) {
            if (y + 1 < h && y - 1 >= 0) {
                let sumDiff = 0, count = 0;
                for (let x = xsStart; x <= xsEnd; x++) {
                    sumDiff += (getPix(x, y + 1) - getPix(x, y - 1));
                    count++;
                }
                topProf.push({ coord: y, d: count > 0 ? sumDiff / count : 0 });
            }
        }
        let topY = findFirstDrop(topProf, minDrop);

        // Bottom profile
        const botProf = [];
        const botLimit = Math.min(h - 2, Math.floor(alCy + dmSize * 1.8));
        for (let y = Math.floor(dmMaxY + qz); y <= botLimit; y++) {
            if (y + 1 < h && y - 1 >= 0) {
                let sumDiff = 0, count = 0;
                for (let x = xsStart; x <= xsEnd; x++) {
                    sumDiff += (getPix(x, y - 1) - getPix(x, y + 1));
                    count++;
                }
                botProf.push({ coord: y, d: count > 0 ? sumDiff / count : 0 });
            }
        }
        let botY = findFirstDrop(botProf, minDrop);

        // Left profile
        const leftProf = [];
        const leftLimit = Math.max(2, Math.floor(alCx - dmSize * 1.8));
        for (let x = Math.floor(dmMinX - qz); x >= leftLimit; x--) {
            if (x + 1 < w && x - 1 >= 0) {
                let sumDiff = 0, count = 0;
                for (let y = ysStart; y <= ysEnd; y++) {
                    sumDiff += (getPix(x + 1, y) - getPix(x - 1, y));
                    count++;
                }
                leftProf.push({ coord: x, d: count > 0 ? sumDiff / count : 0 });
            }
        }
        let leftX = findFirstDrop(leftProf, minDrop);

        // Right profile
        const rightProf = [];
        const rightLimit = Math.min(w - 2, Math.floor(alCx + dmSize * 1.8));
        for (let x = Math.floor(dmMaxX + qz); x <= rightLimit; x++) {
            if (x + 1 < w && x - 1 >= 0) {
                let sumDiff = 0, count = 0;
                for (let y = ysStart; y <= ysEnd; y++) {
                    sumDiff += (getPix(x - 1, y) - getPix(x + 1, y));
                    count++;
                }
                rightProf.push({ coord: x, d: count > 0 ? sumDiff / count : 0 });
            }
        }
        let rightX = findFirstDrop(rightProf, minDrop);

        alignedGray.delete();
        smooth.delete();

        // 3-Corner reconstruction fallback
        const validCount = [topY, botY, leftX, rightX].filter(v => v !== null).length;
        if (validCount === 3) {
            if (topY === null && botY !== null && leftX !== null && rightX !== null) {
                const padW = rightX - leftX;
                topY = Math.max(0, botY - padW);
            } else if (botY === null && topY !== null && leftX !== null && rightX !== null) {
                const padW = rightX - leftX;
                botY = Math.min(h - 1, topY + padW);
            } else if (leftX === null && rightX !== null && topY !== null && botY !== null) {
                const padH = botY - topY;
                leftX = Math.max(0, rightX - padH);
            } else if (rightX === null && leftX !== null && topY !== null && botY !== null) {
                const padH = botY - topY;
                rightX = Math.min(w - 1, leftX + padH);
            }
        }

        if (topY === null || botY === null || leftX === null || rightX === null) {
            mRot.delete();
            mRotInv.delete();
            return { padPts: null, dmPts: orderedDm };
        }

        const padW = rightX - leftX;
        const padH = botY - topY;
        if (padW <= dmW || padH <= dmH) {
            mRot.delete();
            mRotInv.delete();
            return { padPts: null, dmPts: orderedDm };
        }

        const aspect = Math.min(padW, padH) / Math.max(padW, padH);
        if (aspect < 0.35) {
            mRot.delete();
            mRotInv.delete();
            return { padPts: null, dmPts: orderedDm };
        }

        const padAligned = [
            { x: leftX, y: topY },
            { x: rightX, y: topY },
            { x: rightX, y: botY },
            { x: leftX, y: botY }
        ];

        const padOrig = padAligned.map(pt => {
            const rx = mRotInv.doubleAt(0, 0) * pt.x + mRotInv.doubleAt(0, 1) * pt.y + mRotInv.doubleAt(0, 2);
            const ry = mRotInv.doubleAt(1, 0) * pt.x + mRotInv.doubleAt(1, 1) * pt.y + mRotInv.doubleAt(1, 2);
            return { x: rx, y: ry };
        });

        mRot.delete();
        mRotInv.delete();

        return { padPts: this.orderPoints(padOrig), dmPts: orderedDm };
    }

    /**
     * Поиск контуров подложки по белизне и порогу
     */
    detectPadContours(rgbaMat, grayMat, pThresh, pBlur, pMorph) {
        const w = rgbaMat.cols;
        const h = rgbaMat.rows;
        const totalArea = w * h;
        const frameCenter = { x: w / 2.0, y: h / 2.0 };

        const channels = new cv.MatVector();
        cv.split(rgbaMat, channels);
        const whiteMap = new cv.Mat();
        if (channels.size() >= 3) {
            const minRG = new cv.Mat();
            cv.min(channels.get(0), channels.get(1), minRG);
            cv.min(minRG, channels.get(2), whiteMap);
            minRG.delete();
        } else {
            grayMat.copyTo(whiteMap);
        }
        for (let i = 0; i < channels.size(); i++) channels.get(i).delete();
        channels.delete();

        const blurK = Math.max(1, pBlur | 1);
        const blurred = new cv.Mat();
        cv.GaussianBlur(whiteMap, blurred, new cv.Size(blurK, blurK), 0);

        const thresh = new cv.Mat();
        cv.threshold(blurred, thresh, Math.max(0, Math.min(255, pThresh)), 255, cv.THRESH_BINARY);
        blurred.delete();

        const morphK = Math.min(9, Math.max(1, pMorph | 1));
        const threshClean = new cv.Mat();
        if (morphK > 1) {
            const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(morphK, morphK));
            cv.morphologyEx(thresh, threshClean, cv.MORPH_CLOSE, kernel);
            kernel.delete();
        } else {
            thresh.copyTo(threshClean);
        }
        thresh.delete();

        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(threshClean, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        let bestScore = -1e9;
        let bestField = null;

        for (let i = 0; i < contours.size(); ++i) {
            const cnt = contours.get(i);
            const area = cv.contourArea(cnt);
            if (area >= 150.0 && area <= totalArea * 0.98) {
                const rect = cv.minAreaRect(cnt);
                const rw = rect.size.width;
                const rh = rect.size.height;
                if (rw > 8.0 && rh > 8.0) {
                    const boxArea = rw * rh;
                    const rectangularity = area / boxArea;
                    const aspect = Math.min(rw, rh) / Math.max(rw, rh);

                    if (aspect >= 0.30 && rectangularity >= 0.30) {
                        const peri = cv.arcLength(cnt, true);
                        let quadPts = null;

                        for (const epsFactor of [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]) {
                            const approx = new cv.Mat();
                            cv.approxPolyDP(cnt, approx, epsFactor * peri, true);
                            if (approx.rows === 4 && cv.isContourConvex(approx)) {
                                quadPts = [];
                                for (let p = 0; p < 4; p++) {
                                    quadPts.push({ x: approx.data32S[p * 2], y: approx.data32S[p * 2 + 1] });
                                }
                                approx.delete();
                                break;
                            }
                            approx.delete();
                        }

                        if (!quadPts) {
                            quadPts = cv.RotatedRect.points(rect);
                        }

                        const ordered = this.orderPoints(quadPts);
                        const distNorm = Math.hypot(rect.center.x - frameCenter.x, rect.center.y - frameCenter.y) / (Math.hypot(w, h) / 2.0 + 1e-5);
                        const score = area * aspect * rectangularity * (1.0 - 0.25 * distNorm);

                        if (score > bestScore) {
                            bestScore = score;
                            bestField = ordered;
                        }
                    }
                }
            }
            cnt.delete();
        }

        hierarchy.delete();
        contours.delete();
        whiteMap.delete();

        return { padPts: bestField, threshMat: threshClean };
    }

    /**
     * Точное выравнивание и выпрямление DataMatrix в Warp 500x500 (0° tilt)
     */
    refineCodeBox(warpedGrayMat, rawBox) {
        if (!rawBox || rawBox.length === 0) return null;

        const rawMinX = Math.min(...rawBox.map(p => p.x));
        const rawMaxX = Math.max(...rawBox.map(p => p.x));
        const rawMinY = Math.min(...rawBox.map(p => p.y));
        const rawMaxY = Math.max(...rawBox.map(p => p.y));

        const rawW = rawMaxX - rawMinX;
        const rawH = rawMaxY - rawMinY;
        if (rawW < 5.0 || rawH < 5.0) return null;

        let refinedMinX = rawMinX;
        let refinedMaxX = rawMaxX;
        let refinedMinY = rawMinY;
        let refinedMaxY = rawMaxY;
        let foundLocal = false;

        try {
            const marginX = rawW * 0.35;
            const marginY = rawH * 0.35;
            const rx = Math.max(0, Math.floor(rawMinX - marginX));
            const ry = Math.max(0, Math.floor(rawMinY - marginY));
            const rw = Math.min(this.WARP_SIZE - rx, Math.floor(rawW + marginX * 2));
            const rh = Math.min(this.WARP_SIZE - ry, Math.floor(rawH + marginY * 2));

            if (rw > 10 && rh > 10) {
                const rectRoi = new cv.Rect(rx, ry, rw, rh);
                const roiMat = warpedGrayMat.roi(rectRoi);
                const roiThresh = new cv.Mat();
                cv.threshold(roiMat, roiThresh, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);

                const kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
                const roiClosed = new cv.Mat();
                cv.morphologyEx(roiThresh, roiClosed, cv.MORPH_CLOSE, kClose);

                const localCnts = new cv.MatVector();
                const localHier = new cv.Mat();
                cv.findContours(roiClosed, localCnts, localHier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

                const roiCenter = { x: rw / 2.0, y: rh / 2.0 };
                let bestDist = 1e9;
                let bestRect = null;

                for (let i = 0; i < localCnts.size(); i++) {
                    const cnt = localCnts.get(i);
                    const cArea = cv.contourArea(cnt);
                    const expArea = rawW * rawH;
                    if (cArea > expArea * 0.30 && cArea < expArea * 2.5) {
                        const bRect = cv.boundingRect(cnt);
                        const bCenter = { x: bRect.x + bRect.width / 2.0, y: bRect.y + bRect.height / 2.0 };
                        const dist = Math.hypot(bCenter.x - roiCenter.x, bCenter.y - roiCenter.y);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestRect = bRect;
                        }
                    }
                    cnt.delete();
                }

                if (bestRect) {
                    const gMinX = rx + bestRect.x;
                    const gMaxX = rx + bestRect.x + bestRect.width;
                    const gMinY = ry + bestRect.y;
                    const gMaxY = ry + bestRect.y + bestRect.height;

                    if (Math.abs((gMaxX - gMinX) - rawW) < rawW * 0.40 && Math.abs((gMaxY - gMinY) - rawH) < rawH * 0.40) {
                        refinedMinX = gMinX;
                        refinedMaxX = gMaxX;
                        refinedMinY = gMinY;
                        refinedMaxY = gMaxY;
                        foundLocal = true;
                    }
                }

                roiMat.delete();
                roiThresh.delete();
                kClose.delete();
                roiClosed.delete();
                localHier.delete();
                localCnts.delete();
            }
        } catch (e) {}

        if (!foundLocal) {
            const padX = Math.max(1.5, rawW * 0.03);
            const padY = Math.max(1.5, rawH * 0.03);
            refinedMinX = Math.max(0, rawMinX - padX);
            refinedMaxX = Math.min(this.WARP_SIZE, rawMaxX + padX);
            refinedMinY = Math.max(0, rawMinY - padY);
            refinedMaxY = Math.min(this.WARP_SIZE, rawMaxY + padY);
        }

        const straightBox = [
            { x: refinedMinX, y: refinedMinY },
            { x: refinedMaxX, y: refinedMinY },
            { x: refinedMaxX, y: refinedMaxY },
            { x: refinedMinX, y: refinedMaxY }
        ];
        const center = {
            x: (refinedMinX + refinedMaxX) / 2.0,
            y: (refinedMinY + refinedMaxY) / 2.0
        };

        return { box: straightBox, center: center };
    }

    /**
     * Основной пайплайн инспекции
     */
    process(rgbaMat, warpCanvas, frameMm = 15.0, pThresh = 170, pBlur = 5, pMorph = 5, smartMode = true) {
        const w = rgbaMat.cols;
        const h = rgbaMat.rows;

        const grayMat = new cv.Mat();
        cv.cvtColor(rgbaMat, grayMat, cv.COLOR_RGBA2GRAY);

        let bestField = null;
        let method = "none";

        // 1. Поиск контура по порогу
        const { padPts: contourPad, threshMat: threshClean } = this.detectPadContours(rgbaMat, grayMat, pThresh, pBlur, pMorph);

        // 2. Умный поиск (если включен)
        if (smartMode) {
            const { padPts: smartPad } = this.detectSmartPad(grayMat, warpCanvas, 2.5);
            if (smartPad) {
                bestField = smartPad;
                method = "smart";
            }
        }

        // 3. Fallback
        if (!bestField && contourPad) {
            bestField = contourPad;
            method = "classic";
        }

        // Если подложка не найдена
        if (!bestField) {
            grayMat.delete();
            return {
                isSuccess: false,
                padPts: null,
                codeBox: null,
                threshMat: threshClean,
                dxMm: 0,
                dyMm: 0,
                distLeftMm: 0,
                distRightMm: 0,
                distTopMm: 0,
                distBottomMm: 0,
                codeWMm: 0,
                codeHMm: 0,
                method: "none",
                statusText: "Подложка не найдена (отрегулируйте порог)"
            };
        }

        // 4. Perspective Warp в 500x500
        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            bestField[0].x, bestField[0].y,
            bestField[1].x, bestField[1].y,
            bestField[2].x, bestField[2].y,
            bestField[3].x, bestField[3].y
        ]);
        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0,
            this.WARP_SIZE - 1, 0,
            this.WARP_SIZE - 1, this.WARP_SIZE - 1,
            0, this.WARP_SIZE - 1
        ]);
        const M = cv.getPerspectiveTransform(srcTri, dstTri);

        const warpedRgba = new cv.Mat();
        cv.warpPerspective(rgbaMat, warpedRgba, M, new cv.Size(this.WARP_SIZE, this.WARP_SIZE));

        const warpedGray = new cv.Mat();
        cv.cvtColor(warpedRgba, warpedGray, cv.COLOR_RGBA2GRAY);

        // 5. Детекция DataMatrix в 500x500
        cv.imshow(warpCanvas, warpedRgba);
        let rawCodeBox = this.detectDataMatrixZXing(warpCanvas);
        if (!rawCodeBox) {
            rawCodeBox = this.detectDataMatrixContour(warpedGray);
        }

        const refined = this.refineCodeBox(warpedGray, rawCodeBox);

        srcTri.delete();
        dstTri.delete();
        M.delete();
        grayMat.delete();

        if (!refined) {
            warpedRgba.delete();
            warpedGray.delete();
            return {
                isSuccess: true,
                padPts: bestField,
                codeBox: null,
                threshMat: threshClean,
                dxMm: 0,
                dyMm: 0,
                distLeftMm: 0,
                distRightMm: 0,
                distTopMm: 0,
                distBottomMm: 0,
                codeWMm: 0,
                codeHMm: 0,
                method: method,
                statusText: `Подложка найдена [${method === "smart" ? "⚡ Умный" : "⚙ Порог"}], DataMatrix не обнаружен`
            };
        }

        const validCodeBox = refined.box;
        const validCodeCenter = refined.center;

        // 6. Расчет физических отступов в мм
        const boxXs = validCodeBox.map(p => p.x);
        const boxYs = validCodeBox.map(p => p.y);
        const minX = Math.max(0, Math.min(...boxXs));
        const maxX = Math.min(this.WARP_SIZE, Math.max(...boxXs));
        const minY = Math.max(0, Math.min(...boxYs));
        const maxY = Math.min(this.WARP_SIZE, Math.max(...boxYs));

        const pxPerMm = this.WARP_SIZE / Math.max(0.1, frameMm);
        const mmScale = Math.max(0.1, frameMm) / this.WARP_SIZE;

        const distLeft = minX * mmScale;
        const distRight = (this.WARP_SIZE - maxX) * mmScale;
        const distTop = minY * mmScale;
        const distBottom = (this.WARP_SIZE - maxY) * mmScale;
        const codeW = (maxX - minX) * mmScale;
        const codeH = (maxY - minY) * mmScale;

        const dx = (validCodeCenter.x - (this.WARP_SIZE / 2.0)) / pxPerMm;
        const dy = (validCodeCenter.y - (this.WARP_SIZE / 2.0)) / pxPerMm;

        warpedRgba.delete();
        warpedGray.delete();

        const xStr = Math.abs(dx) < 0.01 ? "0.00мм" : (dx > 0 ? `ВЛЕВО ${Math.abs(dx).toFixed(2)}мм` : `ВПРАВО ${Math.abs(dx).toFixed(2)}мм`);
        const yStr = Math.abs(dy) < 0.01 ? "0.00мм" : (dy > 0 ? `ВВЕРХ ${Math.abs(dy).toFixed(2)}мм` : `ВНИЗ ${Math.abs(dy).toFixed(2)}мм`);
        const statusText = `ОСЬ X: ${xStr}  |  ОСЬ Y: ${yStr}`;

        return {
            isSuccess: true,
            padPts: bestField,
            codeBox: validCodeBox,
            codeCenter: validCodeCenter,
            threshMat: threshClean,
            dxMm: dx,
            dyMm: dy,
            distLeftMm: distLeft,
            distRightMm: distRight,
            distTopMm: distTop,
            distBottomMm: distBottom,
            codeWMm: codeW,
            codeHMm: codeH,
            method: method,
            statusText: statusText
        };
    }
}

window.VisionCore = VisionCore;
