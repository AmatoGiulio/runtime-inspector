#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dispatch/dispatch.h>
#import <stdatomic.h>
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
    id displayClassValue = state ? RISafeValue(state, @"displayClass") : nil;

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

static unsigned int RIDisplayClassForDescriptor(id descriptor) {
  id state = RISafeGet(descriptor, @"state", @selector(state));
  id displayClassValue = state ? RISafeValue(state, @"displayClass") : nil;

  if ([displayClassValue respondsToSelector:@selector(unsignedIntValue)]) {
    return [displayClassValue unsignedIntValue];
  }

  if (state && [state respondsToSelector:@selector(displayClass)]) {
    NSMethodSignature *signature = [state methodSignatureForSelector:@selector(displayClass)];
    if (signature && [signature methodReturnLength] <= sizeof(unsigned int)) {
      @try {
        NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:signature];
        [invocation setTarget:state];
        [invocation setSelector:@selector(displayClass)];
        [invocation invoke];
        unsigned int raw = 0;
        [invocation getReturnValue:&raw];
        return raw;
      } @catch (__unused NSException *exception) {
        return UINT_MAX;
      }
    }
  }

  return UINT_MAX;
}

static id RICopyMainDisplayScreenDescriptor(id device, NSString **diagnosticOut) {
  id io = RISafeGet(device, @"io", @selector(io));
  if (!io) {
    if (diagnosticOut) *diagnosticOut = @"device has no io client";
    return nil;
  }

  NSArray *ports = RISafePerform(io, @selector(ioPorts));
  if (![ports isKindOfClass:[NSArray class]]) {
    if (diagnosticOut) *diagnosticOut = @"io client returned no ioPorts";
    return nil;
  }

  SEL registerSelector = NSSelectorFromString(
    @"registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"
  );
  id fallback = nil;

  for (id port in ports) {
    id descriptor = RISafeGet(port, @"descriptor", @selector(descriptor));
    if (!descriptor || ![descriptor respondsToSelector:registerSelector]) continue;

    const unsigned int displayClass = RIDisplayClassForDescriptor(descriptor);
    if (displayClass == 0) {
      [fallback release];
      if (diagnosticOut) *diagnosticOut = @"main SimScreen descriptor";
      return [descriptor retain];
    }

    if (!fallback) {
      fallback = [descriptor retain];
    }
  }

  if (fallback && diagnosticOut) {
    *diagnosticOut = @"fallback SimScreen descriptor";
  }
  return fallback;
}

typedef void (^RIFramePresentedCallback)(void);
typedef void (^RISurfacesChangedCallback)(id, id);
typedef void (^RIPropertiesChangedCallback)(id);

static BOOL RIRegisterScreenCallbacks(
  id descriptor,
  NSUUID *token,
  dispatch_queue_t callbackQueue,
  RIFramePresentedCallback frameCallback,
  RISurfacesChangedCallback surfacesChangedCallback,
  RIPropertiesChangedCallback propertiesChangedCallback,
  NSString **errorOut
) {
  SEL selector = NSSelectorFromString(
    @"registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"
  );
  if (!descriptor || ![descriptor respondsToSelector:selector]) {
    if (errorOut) *errorOut = @"SimScreen registration selector unavailable.";
    return NO;
  }

  @try {
    typedef void (*RIRegisterFn)(
      id,
      SEL,
      NSUUID *,
      dispatch_queue_t,
      RIFramePresentedCallback,
      RISurfacesChangedCallback,
      RIPropertiesChangedCallback
    );
    ((RIRegisterFn)objc_msgSend)(
      descriptor,
      selector,
      token,
      callbackQueue,
      frameCallback,
      surfacesChangedCallback,
      propertiesChangedCallback
    );
    return YES;
  } @catch (NSException *exception) {
    if (errorOut) {
      *errorOut = [NSString stringWithFormat:
        @"SimScreen callback registration raised %@: %@",
        [exception name],
        [exception reason] ?: @"unknown reason"
      ];
    }
    return NO;
  }
}

static void RIUnregisterScreenCallbacks(id descriptor, NSUUID *token) {
  SEL selector = NSSelectorFromString(@"unregisterScreenCallbacksWithUUID:");
  if (!descriptor || !token || ![descriptor respondsToSelector:selector]) return;

  @try {
    typedef void (*RIUnregisterFn)(id, SEL, NSUUID *);
    ((RIUnregisterFn)objc_msgSend)(descriptor, selector, token);
  } @catch (__unused NSException *exception) {
    // Best-effort during helper shutdown.
  }
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

static BOOL RIWriteFrame(
  NSData *payload,
  uint32_t width,
  uint32_t height,
  uint32_t sequence,
  uint64_t capturedAtMs,
  uint32_t encodeDurationUs
) {
  if (!payload || [payload length] > UINT32_MAX) return NO;

  RIFrameHeader header = {
    .magic = CFSwapInt32HostToBig(RIFrameMagic),
    .payloadLength = CFSwapInt32HostToBig((uint32_t)[payload length]),
    .width = CFSwapInt32HostToBig(width),
    .height = CFSwapInt32HostToBig(height),
    .sequence = CFSwapInt32HostToBig(sequence),
    .capturedAtMs = CFSwapInt64HostToBig(capturedAtMs),
    .encodeDurationUs = CFSwapInt32HostToBig(encodeDurationUs)
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


static IOSurfaceRef RICreateBenchmarkSurface(size_t width, size_t height) {
  const size_t bytesPerElement = 4;
  const size_t bytesPerRow = width * bytesPerElement;
  NSDictionary *properties = @{
    (NSString *)kIOSurfaceWidth: @(width),
    (NSString *)kIOSurfaceHeight: @(height),
    (NSString *)kIOSurfaceBytesPerElement: @(bytesPerElement),
    (NSString *)kIOSurfaceBytesPerRow: @(bytesPerRow),
    (NSString *)kIOSurfaceAllocSize: @(bytesPerRow * height)
  };

  IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)properties);
  if (!surface) return NULL;

  if (IOSurfaceLock(surface, 0, NULL) != kIOReturnSuccess) {
    CFRelease(surface);
    return NULL;
  }

  uint8_t *base = (uint8_t *)IOSurfaceGetBaseAddress(surface);
  if (!base) {
    IOSurfaceUnlock(surface, 0, NULL);
    CFRelease(surface);
    return NULL;
  }

  for (size_t y = 0; y < height; y += 1) {
    uint8_t *row = base + y * bytesPerRow;
    for (size_t x = 0; x < width; x += 1) {
      const BOOL light = (((x / 48) + (y / 48)) % 2) == 0;
      const uint8_t accent = (uint8_t)((x * 17 + y * 11) & 0xff);
      const size_t offset = x * 4;

      row[offset + 0] = light ? accent : (uint8_t)(255 - accent);
      row[offset + 1] = (uint8_t)((x * 5 + y * 13) & 0xff);
      row[offset + 2] = light ? 228 : 28;
      row[offset + 3] = 255;
    }
  }

  IOSurfaceUnlock(surface, 0, NULL);
  return surface;
}

static NSData *RICopyScaledRGBAFromSurface(
  IOSurfaceRef surface,
  size_t targetWidth,
  uint32_t *targetHeightOut
) {
  if (!surface) return nil;
  if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess) return nil;

  const size_t sourceWidth = IOSurfaceGetWidth(surface);
  const size_t sourceHeight = IOSurfaceGetHeight(surface);
  const size_t sourceBytesPerRow = IOSurfaceGetBytesPerRow(surface);
  void *baseAddress = IOSurfaceGetBaseAddress(surface);

  if (!baseAddress || sourceWidth == 0 || sourceHeight == 0) {
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
    return nil;
  }

  if (targetWidth == 0 || targetWidth > sourceWidth) targetWidth = sourceWidth;
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
  CGImageRef source = CGImageCreate(
    sourceWidth,
    sourceHeight,
    8,
    32,
    sourceBytesPerRow,
    colorSpace,
    kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst,
    provider,
    NULL,
    false,
    kCGRenderingIntentDefault
  );

  const size_t bytesPerRow = targetWidth * 4;
  NSMutableData *data = [NSMutableData dataWithLength:bytesPerRow * targetHeight];
  CGContextRef context = CGBitmapContextCreate(
    [data mutableBytes],
    targetWidth,
    targetHeight,
    8,
    bytesPerRow,
    colorSpace,
    kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast
  );

  if (source && context) {
    CGContextSetInterpolationQuality(context, kCGInterpolationMedium);
    CGContextDrawImage(context, CGRectMake(0, 0, targetWidth, targetHeight), source);
  } else {
    [data setLength:0];
  }

  if (context) CGContextRelease(context);
  if (source) CGImageRelease(source);
  if (provider) CGDataProviderRelease(provider);
  CGColorSpaceRelease(colorSpace);
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);

  if ([data length] == 0) return nil;
  if (targetHeightOut) *targetHeightOut = (uint32_t)targetHeight;
  return data;
}

static NSData *RICopyJPEGDecodedRGBA(
  NSData *jpeg,
  size_t targetWidth,
  size_t targetHeight
) {
  if (!jpeg || targetWidth == 0 || targetHeight == 0) return nil;

  CGImageSourceRef source = CGImageSourceCreateWithData((CFDataRef)jpeg, NULL);
  if (!source) return nil;

  CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
  CFRelease(source);
  if (!image) return nil;

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  const size_t bytesPerRow = targetWidth * 4;
  NSMutableData *data = [NSMutableData dataWithLength:bytesPerRow * targetHeight];
  CGContextRef context = CGBitmapContextCreate(
    [data mutableBytes],
    targetWidth,
    targetHeight,
    8,
    bytesPerRow,
    colorSpace,
    kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast
  );

  if (context) {
    CGContextSetInterpolationQuality(context, kCGInterpolationMedium);
    CGContextDrawImage(context, CGRectMake(0, 0, targetWidth, targetHeight), image);
  } else {
    [data setLength:0];
  }

  if (context) CGContextRelease(context);
  CGColorSpaceRelease(colorSpace);
  CGImageRelease(image);
  return [data length] > 0 ? data : nil;
}

static double RIPSNRRGB(NSData *reference, NSData *candidate) {
  if (!reference || !candidate || [reference length] != [candidate length]) return 0;

  const uint8_t *a = (const uint8_t *)[reference bytes];
  const uint8_t *b = (const uint8_t *)[candidate bytes];
  const NSUInteger length = [reference length];
  double squaredError = 0;
  uint64_t samples = 0;

  for (NSUInteger offset = 0; offset + 3 < length; offset += 4) {
    for (NSUInteger channel = 0; channel < 3; channel += 1) {
      const double delta = (double)a[offset + channel] - (double)b[offset + channel];
      squaredError += delta * delta;
      samples += 1;
    }
  }

  if (samples == 0) return 0;
  const double mse = squaredError / (double)samples;
  if (mse <= 0.0000001) return 99.0;
  return 10.0 * log10((255.0 * 255.0) / mse);
}

static double RIPercentile(NSArray<NSNumber *> *sorted, double percentile) {
  if ([sorted count] == 0) return 0;
  const double index = percentile * ([sorted count] - 1);
  const NSUInteger lower = (NSUInteger)floor(index);
  const NSUInteger upper = (NSUInteger)ceil(index);
  if (lower == upper) return [[sorted objectAtIndex:lower] doubleValue];
  const double fraction = index - lower;
  const double a = [[sorted objectAtIndex:lower] doubleValue];
  const double b = [[sorted objectAtIndex:upper] doubleValue];
  return a + ((b - a) * fraction);
}

static int RIRunBenchmark(NSArray<NSString *> *arguments) {
  const NSInteger sourceWidth = MAX(
    320,
    [RIArgumentValue(arguments, @"--source-width", @"1320") integerValue]
  );
  const NSInteger sourceHeight = MAX(
    640,
    [RIArgumentValue(arguments, @"--source-height", @"2868") integerValue]
  );
  const NSInteger outputWidth = MAX(
    240,
    MIN(1320, [RIArgumentValue(arguments, @"--width", @"600") integerValue])
  );
  const CGFloat quality = MAX(
    0.2,
    MIN(0.95, [RIArgumentValue(arguments, @"--quality", @"0.65") doubleValue])
  );
  const NSInteger warmup = MAX(
    0,
    [RIArgumentValue(arguments, @"--warmup", @"12") integerValue]
  );
  const NSInteger iterations = MAX(
    1,
    [RIArgumentValue(arguments, @"--iterations", @"80") integerValue]
  );

  IOSurfaceRef surface = RICreateBenchmarkSurface(
    (size_t)sourceWidth,
    (size_t)sourceHeight
  );
  if (!surface) {
    fprintf(stderr, "Could not create deterministic benchmark IOSurface.\n");
    return 5;
  }

  for (NSInteger index = 0; index < warmup; index += 1) {
    @autoreleasepool {
      uint32_t encodedWidth = 0;
      uint32_t encodedHeight = 0;
      NSData *jpeg = RIEncodeSurfaceJPEG(
        surface,
        (size_t)outputWidth,
        quality,
        &encodedWidth,
        &encodedHeight
      );
      if (!jpeg) {
        CFRelease(surface);
        fprintf(stderr, "Framebuffer benchmark warmup encode failed.\n");
        return 6;
      }
    }
  }

  NSMutableArray<NSNumber *> *durations = [NSMutableArray arrayWithCapacity:(NSUInteger)iterations];
  uint64_t totalBytes = 0;
  uint32_t lastWidth = 0;
  uint32_t lastHeight = 0;

  for (NSInteger index = 0; index < iterations; index += 1) {
    @autoreleasepool {
      const CFAbsoluteTime startedAt = CFAbsoluteTimeGetCurrent();
      uint32_t encodedWidth = 0;
      uint32_t encodedHeight = 0;
      NSData *jpeg = RIEncodeSurfaceJPEG(
        surface,
        (size_t)outputWidth,
        quality,
        &encodedWidth,
        &encodedHeight
      );
      const double durationMs =
        (CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0;

      if (!jpeg) {
        CFRelease(surface);
        fprintf(stderr, "Framebuffer benchmark encode failed.\n");
        return 7;
      }

      [durations addObject:@(durationMs)];
      totalBytes += [jpeg length];
      lastWidth = encodedWidth;
      lastHeight = encodedHeight;
    }
  }

  const size_t comparisonWidth = MIN((size_t)600, (size_t)sourceWidth);
  uint32_t comparisonHeight = 0;
  NSData *qualityReference = RICopyScaledRGBAFromSurface(
    surface,
    comparisonWidth,
    &comparisonHeight
  );

  uint32_t qualityWidth = 0;
  uint32_t qualityHeight = 0;
  NSData *qualityJPEG = RIEncodeSurfaceJPEG(
    surface,
    (size_t)outputWidth,
    quality,
    &qualityWidth,
    &qualityHeight
  );

  NSData *qualityCandidate = RICopyJPEGDecodedRGBA(
    qualityJPEG,
    comparisonWidth,
    comparisonHeight
  );

  if (!qualityReference || !qualityJPEG || !qualityCandidate) {
    CFRelease(surface);
    fprintf(stderr, "Framebuffer benchmark quality comparison failed.\n");
    return 9;
  }

  const double psnrDb = RIPSNRRGB(qualityReference, qualityCandidate);

  CFRelease(surface);

  NSArray<NSNumber *> *sorted = [durations sortedArrayUsingSelector:@selector(compare:)];
  double totalMs = 0;
  for (NSNumber *value in durations) {
    totalMs += [value doubleValue];
  }

  const double averageMs = totalMs / MAX(1, [durations count]);
  const double p50Ms = RIPercentile(sorted, 0.50);
  const double p95Ms = RIPercentile(sorted, 0.95);
  const double p99Ms = RIPercentile(sorted, 0.99);
  const double maxMs = [[sorted lastObject] doubleValue];
  const double averageBytes =
    (double)totalBytes / MAX(1, [durations count]);

  NSDictionary *result = @{
    @"sourceWidth": @(sourceWidth),
    @"sourceHeight": @(sourceHeight),
    @"outputWidth": @(lastWidth),
    @"outputHeight": @(lastHeight),
    @"quality": @(quality),
    @"warmup": @(warmup),
    @"iterations": @(iterations),
    @"avgMs": @(averageMs),
    @"p50Ms": @(p50Ms),
    @"p95Ms": @(p95Ms),
    @"p99Ms": @(p99Ms),
    @"maxMs": @(maxMs),
    @"avgBytes": @(averageBytes),
    @"psnrDb": @(psnrDb),
    @"capacityFpsP95": @(p95Ms > 0 ? 1000.0 / p95Ms : 0)
  };

  NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  if (!json) return 8;
  NSString *line = [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] autorelease];
  fprintf(stdout, "%s\n", [line UTF8String]);
  fflush(stdout);
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSArray<NSString *> *arguments = [[NSProcessInfo processInfo] arguments];

    if ([arguments containsObject:@"--benchmark"]) {
      return RIRunBenchmark(arguments);
    }

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
    const NSInteger pollIntervalUs = MAX(
      250,
      MIN(5000, [RIArgumentValue(arguments, @"--poll-us", @"500") integerValue])
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
    const double frameIntervalSeconds = 1.0 / (double)fps;
    const double pollIntervalSeconds = (double)pollIntervalUs / 1000000.0;
    CFAbsoluteTime lastEncodedAt = 0;
    CFAbsoluteTime lastSurfaceRefresh = 0;
    const CFAbsoluteTime streamStartedAt = CFAbsoluteTimeGetCurrent();
    NSString *lastSurfaceDiagnostic = nil;

    NSString *screenDiagnostic = nil;
    id screenDescriptor = RICopyMainDisplayScreenDescriptor(device, &screenDiagnostic);
    dispatch_semaphore_t frameSignal = NULL;
    dispatch_queue_t screenCallbackQueue = NULL;
    NSUUID *screenCallbackToken = nil;
    RIFramePresentedCallback frameCallback = nil;
    RISurfacesChangedCallback surfacesChangedCallback = nil;
    RIPropertiesChangedCallback propertiesChangedCallback = nil;
    _Atomic(int) *surfaceRefreshRequested = calloc(1, sizeof(_Atomic(int)));
    BOOL screenCallbacksEnabled = NO;

    if (screenDescriptor && surfaceRefreshRequested) {
      frameSignal = dispatch_semaphore_create(0);
      screenCallbackQueue = dispatch_queue_create(
        "com.runtime-inspector.framebuffer-callbacks",
        DISPATCH_QUEUE_SERIAL
      );
      screenCallbackToken = [[NSUUID UUID] retain];

      frameCallback = [^{
        dispatch_semaphore_signal(frameSignal);
      } copy];

      surfacesChangedCallback = [^(id framebufferSurface, id maskedFramebufferSurface) {
        (void)framebufferSurface;
        (void)maskedFramebufferSurface;
        atomic_store(surfaceRefreshRequested, 1);
        dispatch_semaphore_signal(frameSignal);
      } copy];

      propertiesChangedCallback = [^(id properties) {
        (void)properties;
      } copy];

      NSString *registrationError = nil;
      screenCallbacksEnabled = RIRegisterScreenCallbacks(
        screenDescriptor,
        screenCallbackToken,
        screenCallbackQueue,
        frameCallback,
        surfacesChangedCallback,
        propertiesChangedCallback,
        &registrationError
      );

      if (screenCallbacksEnabled) {
        fprintf(stderr, "RI_STATUS:frame-source=simscreen-callbacks\n");
        fflush(stderr);
      } else {
        fprintf(
          stderr,
          "RI_STATUS:frame-source=seed-polling fallback=%s\n",
          [[registrationError ?: screenDiagnostic ?: @"unknown" description] UTF8String]
        );
        fflush(stderr);
      }
    } else {
      fprintf(
        stderr,
        "RI_STATUS:frame-source=seed-polling fallback=%s\n",
        [[screenDiagnostic ?: @"SimScreen descriptor unavailable" description] UTF8String]
      );
      fflush(stderr);
    }

    while (true) {
      @autoreleasepool {
        const CFAbsoluteTime frameStart = CFAbsoluteTimeGetCurrent();

        const BOOL callbackSurfaceRefresh =
          screenCallbacksEnabled &&
          surfaceRefreshRequested &&
          atomic_exchange(surfaceRefreshRequested, 0) != 0;

        if (!surface || callbackSurfaceRefresh || frameStart - lastSurfaceRefresh > 1.0) {
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
              if (callbackSurfaceRefresh) {
                lastSeed = UINT32_MAX;
              }
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

        BOOL shouldEncode = NO;
        uint32_t seed = IOSurfaceGetSeed(surface);

        if (screenCallbacksEnabled) {
          if (sequence == 0 || lastSeed == UINT32_MAX) {
            shouldEncode = YES;
          } else {
            const long waitResult = dispatch_semaphore_wait(
              frameSignal,
              dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC)
            );

            if (waitResult != 0) {
              continue;
            }

            while (dispatch_semaphore_wait(frameSignal, DISPATCH_TIME_NOW) == 0) {
              // Coalesce any presents that arrived while the previous frame encoded.
            }

            if (atomic_load(surfaceRefreshRequested) != 0) {
              continue;
            }

            shouldEncode = YES;
            seed = IOSurfaceGetSeed(surface);
          }
        } else {
          const BOOL surfaceChanged = seed != lastSeed || sequence == 0;
          const BOOL frameBudgetReady =
            sequence == 0 ||
            frameStart - lastEncodedAt >= frameIntervalSeconds;
          shouldEncode = surfaceChanged && frameBudgetReady;
        }

        if (shouldEncode) {
          const CFAbsoluteTime encodeStartedAt = CFAbsoluteTimeGetCurrent();
          const uint64_t capturedAtMs = (uint64_t)llround(
            [[NSDate date] timeIntervalSince1970] * 1000.0
          );
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
            const double encodeSeconds = CFAbsoluteTimeGetCurrent() - encodeStartedAt;
            const uint32_t encodeDurationUs = (uint32_t)MIN(
              UINT32_MAX,
              llround(encodeSeconds * 1000000.0)
            );

            if (!RIWriteFrame(
              jpeg,
              encodedWidth,
              encodedHeight,
              sequence,
              capturedAtMs,
              encodeDurationUs
            )) {
              if (surface) CFRelease(surface);
              return 0;
            }

            sequence += 1;
            lastSeed = seed;
            lastEncodedAt = frameStart;
          }
        }

        if (!screenCallbacksEnabled) {
          const CFAbsoluteTime elapsed = CFAbsoluteTimeGetCurrent() - frameStart;
          const double remaining = pollIntervalSeconds - elapsed;
          if (remaining > 0) {
            usleep((useconds_t)(remaining * 1000000.0));
          }
        }
      }
    }

    RIUnregisterScreenCallbacks(screenDescriptor, screenCallbackToken);
    [propertiesChangedCallback release];
    [surfacesChangedCallback release];
    [frameCallback release];
    [screenCallbackToken release];
    [screenDescriptor release];
    [lastSurfaceDiagnostic release];
    if (surface) CFRelease(surface);
  }

  return 0;
}