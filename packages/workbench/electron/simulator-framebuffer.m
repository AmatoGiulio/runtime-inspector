#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#import <unistd.h>

static const uint32_t RIFrameMagic = 0x52494642; // RIFB

typedef struct {
  uint32_t magic;
  uint32_t payloadLength;
  uint32_t width;
  uint32_t height;
  uint32_t sequence;
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

static NSString *RIDeviceUDID(id device) {
  id value = RISafeValue(device, @"UDID");
  if ([value respondsToSelector:@selector(UUIDString)]) {
    return [value UUIDString];
  }
  if ([value isKindOfClass:[NSString class]]) {
    return value;
  }
  return value ? [value description] : nil;
}

static id RIFindDevice(NSString *udid, NSString *developerDir, NSString **errorMessage) {
  dlopen(
    "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
    RTLD_NOW | RTLD_GLOBAL
  );

  NSString *coreSimDeviceIOPath = [
    developerDir stringByAppendingPathComponent:
      @"Library/PrivateFrameworks/CoreSimDeviceIO.framework/CoreSimDeviceIO"
  ];
  dlopen([coreSimDeviceIOPath fileSystemRepresentation], RTLD_NOW | RTLD_GLOBAL);

  Class serviceContextClass = NSClassFromString(@"SimServiceContext");
  if (!serviceContextClass) {
    if (errorMessage) *errorMessage = @"CoreSimulator SimServiceContext is unavailable.";
    return nil;
  }

  id serviceContext = RIInvokeClassObjectError(
    serviceContextClass,
    @selector(sharedServiceContextForDeveloperDir:error:),
    developerDir
  );
  if (!serviceContext) {
    if (errorMessage) *errorMessage = @"Could not open the CoreSimulator service context.";
    return nil;
  }

  id deviceSet = RIInvokeInstanceError(serviceContext, @selector(defaultDeviceSetWithError:));
  NSArray *devices = RISafePerform(deviceSet, @selector(devices));
  if (![devices isKindOfClass:[NSArray class]]) {
    if (errorMessage) *errorMessage = @"Could not read the default Simulator device set.";
    return nil;
  }

  for (id device in devices) {
    NSString *candidate = RIDeviceUDID(device);
    if ([candidate caseInsensitiveCompare:udid] == NSOrderedSame) {
      return device;
    }
  }

  if (errorMessage) {
    *errorMessage = [NSString stringWithFormat:@"Simulator %@ was not found in CoreSimulator.", udid];
  }
  return nil;
}

static IOSurfaceRef RICopyMainDisplaySurface(id device) {
  id io = RISafeValue(device, @"io");
  if (!io) {
    io = RISafePerform(device, NSSelectorFromString(@"io"));
  }

  NSArray *ports = RISafePerform(io, @selector(ioPorts));
  if (![ports isKindOfClass:[NSArray class]]) return NULL;

  IOSurfaceRef fallback = NULL;

  for (id port in ports) {
    id descriptor = RISafeValue(port, @"descriptor");
    if (!descriptor) continue;

    id state = RISafeValue(descriptor, @"state");
    NSNumber *displayClass = RISafeValue(state, @"displayClass");

    id surfaceObject = RISafeValue(descriptor, @"framebufferSurface");
    if (!surfaceObject) {
      surfaceObject = RISafeValue(descriptor, @"ioSurface");
    }
    if (!surfaceObject) continue;

    CFTypeRef value = (__bridge CFTypeRef)surfaceObject;
    if (CFGetTypeID(value) != IOSurfaceGetTypeID()) continue;

    IOSurfaceRef surface = (IOSurfaceRef)value;
    CFRetain(surface);

    if ([displayClass respondsToSelector:@selector(unsignedIntValue)] &&
        [displayClass unsignedIntValue] == 0) {
      if (fallback) CFRelease(fallback);
      return surface;
    }

    if (!fallback) {
      fallback = surface;
    } else {
      CFRelease(surface);
    }
  }

  return fallback;
}

static CGImageRef RICreateImageFromSurface(IOSurfaceRef surface) {
  if (!surface) return NULL;

  uint32_t seed = 0;
  IOReturn lockResult = IOSurfaceLock(surface, kIOSurfaceLockReadOnly, &seed);
  if (lockResult != kIOReturnSuccess) return NULL;

  const size_t width = IOSurfaceGetWidth(surface);
  const size_t height = IOSurfaceGetHeight(surface);
  const size_t bytesPerRow = IOSurfaceGetBytesPerRow(surface);
  const size_t bytesPerElement = IOSurfaceGetBytesPerElement(surface);
  void *baseAddress = IOSurfaceGetBaseAddress(surface);

  if (!baseAddress || width == 0 || height == 0 || bytesPerElement != 4) {
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
    return NULL;
  }

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGDataProviderRef provider = CGDataProviderCreateWithData(
    NULL,
    baseAddress,
    bytesPerRow * height,
    NULL
  );

  CGBitmapInfo bitmapInfo =
    kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst;

  CGImageRef source = CGImageCreate(
    width,
    height,
    8,
    32,
    bytesPerRow,
    colorSpace,
    bitmapInfo,
    provider,
    NULL,
    false,
    kCGRenderingIntentDefault
  );

  CGImageRef copied = NULL;
  if (source) {
    const size_t copiedBytesPerRow = width * 4;
    void *buffer = calloc(height, copiedBytesPerRow);
    if (buffer) {
      CGContextRef context = CGBitmapContextCreate(
        buffer,
        width,
        height,
        8,
        copiedBytesPerRow,
        colorSpace,
        bitmapInfo
      );
      if (context) {
        CGContextDrawImage(context, CGRectMake(0, 0, width, height), source);
        copied = CGBitmapContextCreateImage(context);
        CGContextRelease(context);
      }
      free(buffer);
    }
  }

  if (source) CGImageRelease(source);
  if (provider) CGDataProviderRelease(provider);
  CGColorSpaceRelease(colorSpace);
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
  return copied;
}

static NSData *RIEncodeJPEG(CGImageRef source, size_t targetWidth, CGFloat quality) {
  if (!source) return nil;

  const size_t sourceWidth = CGImageGetWidth(source);
  const size_t sourceHeight = CGImageGetHeight(source);
  if (sourceWidth == 0 || sourceHeight == 0) return nil;

  if (targetWidth == 0 || targetWidth > sourceWidth) {
    targetWidth = sourceWidth;
  }
  const size_t targetHeight = (size_t)llround(
    ((double)sourceHeight / (double)sourceWidth) * (double)targetWidth
  );

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  const size_t bytesPerRow = targetWidth * 4;
  void *buffer = calloc(targetHeight, bytesPerRow);
  if (!buffer) {
    CGColorSpaceRelease(colorSpace);
    return nil;
  }

  CGContextRef context = CGBitmapContextCreate(
    buffer,
    targetWidth,
    targetHeight,
    8,
    bytesPerRow,
    colorSpace,
    kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst
  );
  CGColorSpaceRelease(colorSpace);

  if (!context) {
    free(buffer);
    return nil;
  }

  CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
  CGContextDrawImage(
    context,
    CGRectMake(0, 0, targetWidth, targetHeight),
    source
  );

  CGImageRef scaled = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  free(buffer);
  if (!scaled) return nil;

  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(
    (CFMutableDataRef)data,
    CFSTR("public.jpeg"),
    1,
    NULL
  );
  if (!destination) {
    CGImageRelease(scaled);
    return nil;
  }

  NSDictionary *properties = @{
    (NSString *)kCGImageDestinationLossyCompressionQuality: @(quality)
  };
  CGImageDestinationAddImage(destination, scaled, (CFDictionaryRef)properties);
  BOOL finalized = CGImageDestinationFinalize(destination);

  CFRelease(destination);
  CGImageRelease(scaled);
  return finalized ? data : nil;
}

static BOOL RIWriteFrame(NSData *payload, uint32_t width, uint32_t height, uint32_t sequence) {
  if (!payload || [payload length] > UINT32_MAX) return NO;

  RIFrameHeader header = {
    .magic = CFSwapInt32HostToBig(RIFrameMagic),
    .payloadLength = CFSwapInt32HostToBig((uint32_t)[payload length]),
    .width = CFSwapInt32HostToBig(width),
    .height = CFSwapInt32HostToBig(height),
    .sequence = CFSwapInt32HostToBig(sequence)
  };

  if (fwrite(&header, sizeof(header), 1, stdout) != 1) return NO;
  if (fwrite([payload bytes], [payload length], 1, stdout) != 1) return NO;
  fflush(stdout);
  return YES;
}

static NSString *RIArgumentValue(NSArray<NSString *> *arguments, NSString *name, NSString *fallback) {
  NSUInteger index = [arguments indexOfObject:name];
  if (index == NSNotFound || index + 1 >= [arguments count]) return fallback;
  return [arguments objectAtIndex:index + 1];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSArray<NSString *> *arguments = [[NSProcessInfo processInfo] arguments];
    NSString *udid = RIArgumentValue(arguments, @"--udid", nil);
    const NSInteger fps = MAX(1, MIN(60, [RIArgumentValue(arguments, @"--fps", @"60") integerValue]));
    const NSInteger outputWidth = MAX(
      240,
      MIN(1320, [RIArgumentValue(arguments, @"--width", @"640") integerValue])
    );
    const CGFloat quality = MAX(
      0.2,
      MIN(0.95, [RIArgumentValue(arguments, @"--quality", @"0.72") doubleValue])
    );

    if (![udid length]) {
      fprintf(stderr, "A Simulator UDID is required.\n");
      return 2;
    }

    NSString *developerDir = [[[NSProcessInfo processInfo] environment] objectForKey:@"RI_DEVELOPER_DIR"];
    if (![developerDir length]) {
      developerDir = @"/Applications/Xcode.app/Contents/Developer";
    }

    NSString *errorMessage = nil;
    id device = RIFindDevice(udid, developerDir, &errorMessage);
    if (!device) {
      fprintf(stderr, "%s\n", [[errorMessage ?: @"Could not find Simulator." description] UTF8String]);
      return 3;
    }

    IOSurfaceRef surface = NULL;
    uint32_t surfaceID = 0;
    uint32_t lastSeed = UINT32_MAX;
    uint32_t sequence = 0;
    const useconds_t frameInterval = (useconds_t)(1000000 / fps);
    CFAbsoluteTime lastSurfaceRefresh = 0;

    while (true) {
      @autoreleasepool {
        const CFAbsoluteTime frameStart = CFAbsoluteTimeGetCurrent();

        if (!surface || frameStart - lastSurfaceRefresh > 1.0) {
          IOSurfaceRef nextSurface = RICopyMainDisplaySurface(device);
          lastSurfaceRefresh = frameStart;
          if (nextSurface) {
            uint32_t nextID = IOSurfaceGetID(nextSurface);
            if (!surface || nextID != surfaceID) {
              if (surface) CFRelease(surface);
              surface = nextSurface;
              surfaceID = nextID;
              lastSeed = UINT32_MAX;
            } else {
              CFRelease(nextSurface);
            }
          }
        }

        if (!surface) {
          usleep(100000);
          continue;
        }

        const uint32_t seed = IOSurfaceGetSeed(surface);
        if (seed != lastSeed || sequence == 0) {
          CGImageRef image = RICreateImageFromSurface(surface);
          if (image) {
            NSData *jpeg = RIEncodeJPEG(image, (size_t)outputWidth, quality);
            CGImageRelease(image);

            if (jpeg) {
              const size_t sourceWidth = IOSurfaceGetWidth(surface);
              const size_t sourceHeight = IOSurfaceGetHeight(surface);
              const uint32_t encodedWidth = (uint32_t)MIN((size_t)outputWidth, sourceWidth);
              const uint32_t encodedHeight = (uint32_t)llround(
                ((double)sourceHeight / (double)sourceWidth) * encodedWidth
              );

              if (!RIWriteFrame(jpeg, encodedWidth, encodedHeight, sequence)) {
                if (surface) CFRelease(surface);
                return 0;
              }
              sequence += 1;
              lastSeed = seed;
            }
          }
        }

        const CFAbsoluteTime elapsed = CFAbsoluteTimeGetCurrent() - frameStart;
        const double remaining = ((double)frameInterval / 1000000.0) - elapsed;
        if (remaining > 0) {
          usleep((useconds_t)(remaining * 1000000.0));
        }
      }
    }

    if (surface) CFRelease(surface);
  }

  return 0;
}
