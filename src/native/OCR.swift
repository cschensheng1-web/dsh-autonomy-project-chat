import Foundation
import Vision
import ImageIO
import CoreGraphics

// Fixed byte-in/text-out helper. No source filenames, URLs, commands or
// credentials are accepted. Image/PDF rendering and recognition stay on-device.
enum OCRFailure: Error { case message(String) }
func fail(_ message: String) throws -> Never { throw OCRFailure.message(message) }
let maxBytes = 32 * 1024 * 1024
let maxPixels = 40_000_000
let rasterPixels = 6_000_000.0

func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation = .up) throws -> (String, Int) {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.preferBackgroundProcessing = true
    let available = try request.supportedRecognitionLanguages()
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"].filter { available.contains($0) }
    try VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:]).perform([request])
    var text = ""
    var count = 0
    // Vision's reading order is approximate; retain one observation per line.
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        if text.count + candidate.string.count > 200_000 || count >= 5000 { break }
        text += candidate.string + "\n"
        count += 1
    }
    return (text.trimmingCharacters(in: .whitespacesAndNewlines), count)
}

func readImage(_ bytes: Data, page: Int) throws -> [String: Any] {
    guard let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { try fail("图片格式不受系统支持，或文件已经损坏。") }
    let total = CGImageSourceGetCount(source)
    guard page <= total else { try fail("图片页码超出范围。") }
    let index = page - 1
    guard let props = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any], let width = props[kCGImagePropertyPixelWidth] as? Int, let height = props[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0, width <= maxPixels / height else { try fail("图片像素超过 4000 万或尺寸无效，请选较小的图片。") }
    let side = min(4096, max(1, Int(sqrt(rasterPixels / Double(width * height)) * Double(max(width, height)))))
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: min(max(width, height), side), kCGImageSourceShouldCacheImmediately: true]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else { try fail("图片解码失败。") }
    let (text, count) = try recognize(image)
    return ["format": "image-ocr", "sections": [["location": "图片第 \(page) 页 · OCR", "text": text]], "totalPages": total, "ocr": true, "truncated": count >= 5000 || text.count >= 199_000, "warnings": ["已在本机 OCR 识字；识别结果可能有错字、漏字，表格顺序和手写/公式可能不准确。这不等于模型看到了原图。", total > 1 ? "本次只识别第 \(page) 帧/页，共 \(total) 帧/页；可用 page 指定其他页，动画未作为视频理解。" : "仅提取文字，不推断照片内容、图形关系或颜色含义。"]]
}

func readPDF(_ bytes: Data, first: Int, limit: Int) throws -> [String: Any] {
    guard let provider = CGDataProvider(data: bytes as CFData), let document = CGPDFDocument(provider) else { try fail("PDF 无法打开，可能已损坏。") }
    if document.isEncrypted { try fail("PDF 已加密，OCR 不接收密码。") }
    let total = document.numberOfPages
    guard first <= total else { try fail("PDF 页码超出范围。") }
    var sections: [[String: String]] = []
    var last = first - 1
    for number in first...min(total, first + limit - 1) {
        try autoreleasepool {
            guard let page = document.page(at: number) else { try fail("PDF 页面无法打开。") }
            let bounds = page.getBoxRect(.cropBox)
            guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0, bounds.width < 100_000, bounds.height < 100_000 else { try fail("PDF 页面尺寸无效或过大。") }
            let scale = min(2.5, sqrt(rasterPixels / (bounds.width * bounds.height)), 4096 / max(bounds.width, bounds.height))
            let width = max(1, Int(bounds.width * scale)), height = max(1, Int(bounds.height * scale))
            guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { try fail("PDF 页面渲染内存不足。") }
            let rect = CGRect(x: 0, y: 0, width: width, height: height)
            context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(rect)
            context.concatenate(page.getDrawingTransform(.cropBox, rect: rect, rotate: 0, preserveAspectRatio: true))
            context.drawPDFPage(page)
            guard let image = context.makeImage() else { try fail("PDF 页面渲染失败。") }
            let (text, _) = try recognize(image)
            sections.append(["location": "第 \(number) 页 · OCR", "text": text])
            last = number
        }
    }
    return ["format": "pdf-ocr", "sections": sections, "totalPages": total, "ocr": true, "truncated": first > 1 || last < total, "warnings": ["已在本机将选定 PDF 页渲染后 OCR；文字、表格、手写和公式可能识别不完整，结果需与原页核对。", "本次识别第 \(first) 至 \(last) 页，共 \(total) 页。使用 ocr:true 和 page 可读取指定页。"]]
}

do {
    let arguments = CommandLine.arguments
    guard arguments.count == 4, ["image", "pdf"].contains(arguments[1]), let page = Int(arguments[2]), let limit = Int(arguments[3]), (1...600).contains(page), (1...3).contains(limit) else { try fail("OCR 参数无效。") }
    let handle = FileHandle.standardInput
    var bytes = Data()
    while true {
        let next = try handle.read(upToCount: 65536) ?? Data()
        if next.isEmpty { break }
        if bytes.count + next.count > maxBytes { try fail("OCR 文件超过 32 MiB。") }
        bytes.append(next)
    }
    if bytes.isEmpty { try fail("OCR 文件为空。") }
    let result = try arguments[1] == "pdf" ? readPDF(bytes, first: page, limit: limit) : readImage(bytes, page: page)
    let encoded = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(encoded)
} catch {
    let message: String
    if case OCRFailure.message(let value) = error { message = value } else { message = "本机 OCR 无法完成识别，图片可能损坏、文字过小或系统识别服务不可用。" }
    let data = try! JSONSerialization.data(withJSONObject: ["error": message])
    FileHandle.standardOutput.write(data)
    exit(1)
}
