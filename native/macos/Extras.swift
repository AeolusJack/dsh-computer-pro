import Foundation
import Vision
import ImageIO
import CryptoKit

struct Failure: Error { let message: String }
func catalog() -> [[String:String]] {
    var found:[[String:String]]=[]
    let fm=FileManager.default
    func scan(_ url:URL,_ depth:Int) {
        guard depth<=2, let children=try? fm.contentsOfDirectory(at:url,includingPropertiesForKeys:[.isDirectoryKey],options:[.skipsHiddenFiles]) else{return}
        for child in children {
            if child.pathExtension=="app" {
                let id=SHA256.hash(data:Data(child.path.utf8)).map{String(format:"%02x",$0)}.joined()
                found.append(["id":id,"name":child.deletingPathExtension().lastPathComponent,"path":child.path])
            } else if (try? child.resourceValues(forKeys:[.isDirectoryKey]).isDirectory)==true {scan(child,depth+1)}
        }
    }
    for root in ["/Applications","/System/Applications",fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path] {scan(URL(fileURLWithPath:root),0)}
    return found.sorted{($0["name"] ?? "") < ($1["name"] ?? "")}
}
func perform(_ r:[String:Any]) throws -> Any {
    let languages=try VNRecognizeTextRequest().supportedRecognitionLanguages()
    switch r["method"] as? String {
    case "capabilities": return ["platform":"macos","languages":languages]
    case "apps": return catalog()
    case "launch":
        guard let id=r["id"] as? String, let app=catalog().first(where:{$0["id"]==id}) else{throw Failure(message:"APP_NOT_IN_CATALOG")}
        let p=Process();p.executableURL=URL(fileURLWithPath:"/usr/bin/open");p.arguments=["-a",app["path"]!]
        p.standardOutput=FileHandle.nullDevice;p.standardError=FileHandle.nullDevice
        try p.run();p.waitUntilExit();guard p.terminationStatus==0 else{throw Failure(message:"LAUNCH_FAILED")}
        return ["dispatched":true,"verified":false,"app":app] as [String:Any]
    case "ocr":
        guard let path=r["path"] as? String else{throw Failure(message:"IMAGE_REQUIRED")}
        let url=URL(fileURLWithPath:path)
        guard let bytes=try url.resourceValues(forKeys:[.fileSizeKey]).fileSize,bytes<=32*1024*1024,
              let source=CGImageSourceCreateWithURL(url as CFURL,nil),
              let props=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
              let w=props[kCGImagePropertyPixelWidth] as? Int,let h=props[kCGImagePropertyPixelHeight] as? Int,
              w>0,h>0,w<=16384,h<=16384,w*h<=25_000_000,
              let image=CGImageSourceCreateImageAtIndex(source,0,nil) else{throw Failure(message:"INVALID_OR_OVERSIZE_IMAGE")}
        let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.usesLanguageCorrection=true
        if let language=r["language"] as? String,!language.isEmpty {
            guard languages.contains(language) else{throw Failure(message:"OCR_LANGUAGE_UNAVAILABLE")}
            request.recognitionLanguages=[language]
        }
        try VNImageRequestHandler(cgImage:image).perform([request])
        let lines=(request.results ?? []).compactMap { observation -> [String:Any]? in
            guard let candidate=observation.topCandidates(1).first else{return nil}
            let b=observation.boundingBox
            return ["text":candidate.string,"confidence":candidate.confidence,"x":b.minX*Double(w),"y":(1-b.maxY)*Double(h),"width":b.width*Double(w),"height":b.height*Double(h)]
        }
        return ["text":lines.compactMap{$0["text"] as? String}.joined(separator:"\n"),"width":w,"height":h,"coordinateSpace":"image-pixels-top-left","lines":lines]
    default: throw Failure(message:"UNKNOWN_METHOD")
    }
}
do {
    let data=FileHandle.standardInput.readDataToEndOfFile()
    guard data.count<=65536,let request=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw Failure(message:"INVALID_REQUEST")}
    let result=try perform(request)
    print(String(data:try JSONSerialization.data(withJSONObject:["ok":true,"result":result],options:[.sortedKeys]),encoding:.utf8)!)
} catch {
    let message=(error as? Failure)?.message ?? String(describing:error)
    let data=try! JSONSerialization.data(withJSONObject:["ok":false,"error":message])
    print(String(data:data,encoding:.utf8)!);exit(1)
}
