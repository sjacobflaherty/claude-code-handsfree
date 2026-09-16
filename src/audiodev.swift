import CoreAudio
import Foundation

func propertyAddress(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    return AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func deviceName(_ deviceID: AudioDeviceID) -> String {
    var address = propertyAddress(kAudioObjectPropertyName)
    var name: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &name) { ptr in
        AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, ptr)
    }
    if status != noErr { return "" }
    return name as String
}

// The UID is the string form of the device, and it is what `hear -n` takes; the numeric id means nothing to hear.
func deviceUID(_ deviceID: AudioDeviceID) -> String {
    var address = propertyAddress(kAudioDevicePropertyDeviceUID)
    var uid: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &uid) { ptr in
        AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, ptr)
    }
    if status != noErr { return "" }
    return uid as String
}

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID {
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = propertyAddress(selector)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
    if status != noErr { return 0 }
    return deviceID
}

// A device has streams in a scope when it can record (input) or play (output) there.
func streamCount(_ deviceID: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
    var address = propertyAddress(kAudioDevicePropertyStreams, scope)
    var size = UInt32(0)
    let status = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size)
    if status != noErr { return 0 }
    return Int(size) / MemoryLayout<AudioStreamID>.size
}

func allDevices() -> [AudioDeviceID] {
    var address = propertyAddress(kAudioHardwarePropertyDevices)
    var size = UInt32(0)
    if AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) != noErr { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) != noErr { return [] }
    return ids
}

let inID = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
let outID = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
print("in=" + (inID == 0 ? "" : deviceName(inID)))
print("out=" + (outID == 0 ? "" : deviceName(outID)))
for id in allDevices() {
    let hasIn = streamCount(id, kAudioObjectPropertyScopeInput) > 0
    let hasOut = streamCount(id, kAudioObjectPropertyScopeOutput) > 0
    if !hasIn && !hasOut { continue }
    let dir = hasIn && hasOut ? "both" : (hasIn ? "in" : "out")
    print("dev=\(id)\t\(deviceUID(id))\t\(dir)\t\(deviceName(id))")
}
