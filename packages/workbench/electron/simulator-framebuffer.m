#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#import <unistd.h>
#import <math.h>

static const uint32_t RIFrameMagic = 0x52494642; // RIFB

typedef struct __attribute__((packed)) {
  uint32_t magic;
  uint32_t payloadLength;
  uint32_t width;
  uint32_t height;
  uint32_t sequence;
  uint64_t capturedAtMs;
  uint32_t encodeDurationUs;
} RIFrameHeader;

static id RIInvokeClassObjectError(Class cls, SEL selector, id object) {
  NSMethodSignature *signature = [cls methodSignatureForSelector:selector];
  if (!signature) return nil;
  NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:signature];
  [invocation setTarget:cls];
  [invocation setSelector:selector];
  if (object) [invocation setArgument:&object atIndex:2];
  NSError *error = nil;
  [invocation setArgument:&error atIndex:3];
  [invocation invoke];
  id result = nil;
  [invocation getReturnValue:&result];
  return result;
}

static id RIInvokeInstanceError(id target, SEL selector) {
  NSMethodSignature *signature = [target methodSignatureForSelector:selector];
  if (!signature) return nil;
  NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:signature];
  [invocation setTarget:target];
  [invocation setSelector:selector];
  NSError *error = nil;
  [invocation setArgument:&error atIndex:2];
  [invocation invoke];
  id result = nil;
  [invocation getReturnValue:&result];
  return result;
}

static id RISafeValue(id object, NSString *key) {
  if (!object) return nil;
  @try {
    return [object valueForKey:key];
  } @catch (__unused NSException *exception) {
    return nil;
  }
}

static id RISafePerform(id object, SEL selector) {
  if (!object || ![object respondsToSelector:selector]) return nil;
  @try {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    return [object performSelector:selector];
#pragma clang diagnostic pop
  } @catch (__unused NSException *exception) {
    return nil;
  }
}
static id RISafeGet(id object, NSString *key, SEL selector) {
  id value = RISafePerform(object, selector);
  if (value) return value;
  return RISafeValue(object, key);
}


static NSString *RIDeviceUDID(id device) {
  id value = RISafeValue(device, @"UDID");
  if ([value respondsToSelector:@selector(UUIDString)]) {
    return [value UUIDString];