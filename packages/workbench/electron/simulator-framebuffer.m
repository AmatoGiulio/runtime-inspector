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
static id RISafeGet(id object, NSString *key, SEL selector) {
  id value = RISafePerform(object, selector);
  if (value) return value;
  return RISafeValue(object, key);
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

static IOSurfaceRef RICopyMainDisplaySurface(id device, NSString **diagnosticOut) {
  id io = RISafeGet(device, @"io", @selector(io));
  if (!io) {
    if (diagnosticOut) {
      *diagnosticOut = [NSString stringWithFormat:@"device %@ has no io client", NSStringFromClass([device class])];
    }
    return NULL;
  }

  NSArray *ports = RISafePerform(io, @selector(ioPorts));
  if (![ports isKindOfClass:[NSArray class]]) {
    if (diagnosticOut) {
      *diagnosticOut = [NSString stringWithFormat:@"io client %@ returned no ioPorts", NSStringFromClass([io class])];
    }
    return NULL;
  }

  IOSurfaceRef fallback = NULL;
  NSMutableArray<NSString *> *observations = [NSMutableArray array];

  for (id port in ports) {
    id descriptor = RISafeGet(port, @"descriptor", @selector(descriptor));
    if (!descriptor) {
      [observations addObject:[NSString stringWithFormat:@"port %@: no descriptor", NSStringFromClass([port class])]];
      continue;
    }

    id state = RISafeGet(descriptor, @"state", @selector(state));
    id displayClassValue = state
      ? RISafeGet(state, @"displayClass", @selector(displayClass))
      : nil;

    unsigned int displayClass = UINT_MAX;
    if ([displayClassValue respondsToSelector:@selector(unsignedIntValue)]) {
      displayClass = [displayClassValue unsignedIntValue];
    } else if (state && [state respondsToSelector:@selector(displayClass)]) {
      NSMethodSignature *signature = [state methodSignatureForSelector:@selector(displayClass)];
      if (signature && [signature methodReturnLength] <= sizeof(unsigned int)) {
        @try {
          NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:signature];
          [invocation setTarget:state];
          [invocation setSelector:@selector(displayClass)];
          [invocation invoke];
          unsigned int raw = 0;
          [invocation getReturnValue:&raw];
          displayClass = raw;
        } @catch (__unused NSException *exception) {
          displayClass = UINT_MAX;
        }
      }
    }

    id surfaceObject = RISafePerform(descriptor, NSSelectorFromString(@"framebufferSurface"));
    if (!surfaceObject) {
      surfaceObject = RISafePerform(descriptor, NSSelectorFromString(@"ioSurface"));
    }

    if (!surfaceObject) {
      [observations addObject:[
        NSString stringWithFormat:
          @"descriptor %@ class=%@ displayClass=%@ has no framebufferSurface/ioSurface",
          descriptor,
          NSStringFromClass([descriptor class]),
          displayClass == UINT_MAX ? @"?" : [NSString stringWithFormat:@"%u", displayClass]
      ]];
      continue;
    }

    CFTypeRef value = (__bridge CFTypeRef)surfaceObject;
    if (CFGetTypeID(value) != IOSurfaceGetTypeID()) {
      [observations addObject:[
        NSString stringWithFormat:
          @"descriptor %@ returned surface type %@",
          NSStringFromClass([descriptor class]),
          NSStringFromClass([surfaceObject class])
      ]];
      continue;
    }

    IOSurfaceRef surface = (IOSurfaceRef)value;
    CFRetain(surface);

    if (displayClass == 0) {
      if (fallback) CFRelease(fallback);
      if (diagnosticOut) {
        *diagnosticOut = [NSString stringWithFormat:@"main display surface=%u", IOSurfaceGetID(surface)];
      }
      return surface;
    }

    if (!fallback) {
      fallback = surface;
    } else {
      CFRelease(surface);
    }
  }

  if (fallback) {
    if (diagnosticOut) {
      *diagnosticOut = [NSString stringWithFormat:@"using fallback display surface=%u", IOSurfaceGetID(fallback)];
    }
    return fallback;
  }

  if (diagnosticOut) {
    NSString *joined = [observations componentsJoinedByString:@"; "];
    *diagnosticOut = [NSString stringWithFormat:
      @"io=%@ ports=%lu %@",
      NSStringFromClass([io class]),
      (unsigned long)[ports count],
      [joined length] ? joined : @"no renderable display descriptors"
    ];
  }
  return NULL;
}

static NSData *RIEncodeSurfaceJPEG(
  IOSurfaceRef surface,
  size_t targetWidth,
  CGFloat quality,
  uint32_t *encodedWidthOut,
  uint32_t *encodedHeightOut
) {
  if (!surface) return nil;

  uint32_t seed = 0;
  IOReturn lockResult = IOSurfaceLock(surface, kIOSurfaceLockReadOnly, &seed);
  if (lockResult != kIOReturnSuccess) return nil;

  const size_t sourceWidth = IOSurfaceGetWidth(surface);
  const size_t sourceHeight = IOSurfaceGetHeight(surface);
  const size_t sourceBytesPerRow = IOSurfaceGetBytesPerRow(surface);
  const size_t bytesPerElement = IOSurfaceGetBytesPerElement(surface);
  void *baseAddress = IOSurfaceGetBaseAddress(surface);

  if (!baseAddress || sourceWidth == 0 || sourceHeight == 0 || bytesPerElement != 4) {
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
    return nil;
  }

  if (targetWidth == 0 || targetWidth > sourceWidth) {
    targetWidth = sourceWidth;
  }
  const size_t targetHeight = (size_t)llround(
    ((double)sourceHeight / (double)sourceWidth) * (double)targetWidth
  );

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGDataProviderRef provider = CGDataProviderCreateWithData(
    NULL,
    baseAddress,
    sourceBytesPerRow * sourceHeight,
    NULL
  );

  CGBitmapInfo bitmapInfo =
    kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst;

  CGImageRef source = CGImageCreate(
    sourceWidth,
    sourceHeight,
    8,
    32,
    sourceBytesPerRow,
    colorSpace,
    bitmapInfo,
    provider,
    NULL,
    false,
    kCGRenderingIntentDefault
  );

  const size_t targetBytesPerRow = targetWidth * 4;
  void *targetBuffer = calloc(targetHeight, targetBytesPerRow);
  CGContextRef targetContext = targetBuffer
    ? CGBitmapContextCreate(
        targetBuffer,
        targetWidth,
        targetHeight,
        8,
        targetBytesPerRow,
        colorSpace,
        bitmapInfo
      )
    : NULL;

  CGImageRef scaled = NULL;
  if (source && targetContext) {
    CGContextSetInterpolationQuality(targetContext, kCGInterpolationMedium);
    CGContextDrawImage(
      targetContext,
      CGRectMake(0, 0, targetWidth, targetHeight),
      source
    );
    scaled = CGBitmapContextCreateImage(targetContext);
  }

  if (targetContext) CGContextRelease(targetContext);
  if (targetBuffer) free(targetBuffer);
  if (source) CGImageRelease(source);
  if (provider) CGDataProviderRelease(provider);
  CGColorSpaceRelease(colorSpace);
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);

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

  if (!finalized) return nil;
  if (encodedWidthOut) *encodedWidthOut = (uint32_t)targetWidth;
  if (encodedHeightOut) *encodedHeightOut = (uint32_t)targetHeight;
  return data;
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
    const CFAbsoluteTime streamStartedAt = CFAbsoluteTimeGetCurrent();
    NSString *lastSurfaceDiagnostic = nil;

    while (true) {
      @autoreleasepool {
        const CFAbsoluteTime frameStart = CFAbsoluteTimeGetCurrent();

        if (!surface || frameStart - lastSurfaceRefresh > 1.0) {
          NSString *surfaceDiagnostic = nil;
          IOSurfaceRef nextSurface = RICopyMainDisplaySurface(device, &surfaceDiagnostic);
          [lastSurfaceDiagnostic release];
          lastSurfaceDiagnostic = [surfaceDiagnostic copy];
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
          if (frameStart - streamStartedAt > 5.0) {
            fprintf(
              stderr,
              "Could not locate the main CoreSimulator IOSurface for %s within 5 seconds. %s\n",
              [udid UTF8String],
              [[lastSurfaceDiagnostic ?: @"No surface diagnostics available." description] UTF8String]
            );
            [lastSurfaceDiagnostic release];
            return 4;
          }
          usleep(100000);
          continue;
        }

        const uint32_t seed = IOSurfaceGetSeed(surface);
        if (seed != lastSeed || sequence == 0) {
          uint32_t encodedWidth = 0;
          uint32_t encodedHeight = 0;
          NSData *jpeg = RIEncodeSurfaceJPEG(
            surface,
            (size_t)outputWidth,
            quality,
            &encodedWidth,
            &encodedHeight
          );

          if (jpeg) {
            if (!RIWriteFrame(jpeg, encodedWidth, encodedHeight, sequence)) {
              if (surface) CFRelease(surface);
              return 0;
            }
            sequence += 1;
            lastSeed = seed;
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