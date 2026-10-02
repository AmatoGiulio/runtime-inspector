#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>
#import <objc/runtime.h>

typedef void *(*RIIndigoMouseMessageFn)(
  CGPoint *primaryPoint,
  void *secondaryPoint,
  int target,
  int eventType,
  int direction
);

typedef struct {
  RIIndigoMouseMessageFn messageFn;
  id client;
  SEL sendSelector;
  NSMethodSignature *sendSignature;
  NSString *udid;
} RIHIDContext;

static void RIWriteResponse(NSNumber *requestId, BOOL ok, NSString *message) {
  NSDictionary *payload = @{
    @"id": requestId ?: @0,
    @"ok": @(ok),
    @"message": message ?: [NSNull null]
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (!data) return;
  NSString *line = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (!line) return;
  fprintf(stdout, "%s\n", [line UTF8String]);
  fflush(stdout);
  [line release];
}

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

static id RIInvokeInstanceObjectError(id target, SEL selector, id object) {
  NSMethodSignature *signature = [target methodSignatureForSelector:selector];
  if (!signature) return nil;
  NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:signature];
  [invocation setTarget:target];
  [invocation setSelector:selector];
  if (object) [invocation setArgument:&object atIndex:2];
  NSError *error = nil;
  [invocation setArgument:&error atIndex:3];
  [invocation invoke];
  id result = nil;
  [invocation getReturnValue:&result];
  return result;
}

static NSString *RIDeviceUDID(id device) {
  id value = nil;
  @try {
    value = [device valueForKey:@"UDID"];
  } @catch (__unused NSException *exception) {
    value = nil;
  }
  if ([value respondsToSelector:@selector(UUIDString)]) {
    return [value UUIDString];
  }
  if ([value isKindOfClass:[NSString class]]) {
    return value;
  }
  return value ? [value description] : nil;
}

static void *RICreateMessage(
  RIIndigoMouseMessageFn function,
  double x,
  double y,
  int eventType,
  int direction
) {
#if defined(__arm64__)
  CGPoint point = CGPointMake(x, y);
  double one = 1.0;
  __asm__ volatile(
    "ldr d0, %[one]\n"
    "ldr d1, %[one]\n"
    "ldr d2, %[one]\n"
    "ldr d3, %[one]\n"
    :
    : [one] "m" (one)
    : "d0", "d1", "d2", "d3"
  );
  return function(&point, NULL, 0x32, eventType, direction);
#else
  return NULL;
#endif
}

static BOOL RISendMessage(RIHIDContext *context, void *message, NSString **errorMessage) {
  if (!context || !message) {
    if (errorMessage) *errorMessage = @"Could not construct Simulator HID message.";
    return NO;
  }

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0);
  BOOL freeWhenDone = YES;
  __block NSError *sendError = nil;

  void (^completion)(NSError *) = ^(NSError *error) {
    if (error) sendError = [error retain];
    dispatch_semaphore_signal(semaphore);
  };

  NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:context->sendSignature];
  [invocation setTarget:context->client];
  [invocation setSelector:context->sendSelector];
  [invocation setArgument:&message atIndex:2];
  [invocation setArgument:&freeWhenDone atIndex:3];
  [invocation setArgument:&queue atIndex:4];
  [invocation setArgument:&completion atIndex:5];
  [invocation invoke];

  long waitResult = dispatch_semaphore_wait(
    semaphore,
    dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)
  );

  if (waitResult != 0) {
    if (errorMessage) *errorMessage = @"Simulator HID send timed out.";
    return NO;
  }

  if (sendError) {
    if (errorMessage) *errorMessage = [sendError description];
    [sendError release];
    return NO;
  }

  return YES;
}

static void RIDestroyContext(RIHIDContext **contextPointer) {
  if (!contextPointer || !*contextPointer) return;
  RIHIDContext *context = *contextPointer;
  [context->client release];
  [context->sendSignature release];
  [context->udid release];
  free(context);
  *contextPointer = NULL;
}

static RIHIDContext *RICreateContext(NSString *udid, NSString **errorMessage) {
#if !defined(__arm64__)
  if (errorMessage) *errorMessage = @"The current Simulator HID spike supports Apple Silicon only.";
  return NULL;
#else
  NSString *developerDir = [[[NSProcessInfo processInfo] environment] objectForKey:@"RI_DEVELOPER_DIR"];
  if (![developerDir length]) {
    developerDir = @"/Applications/Xcode.app/Contents/Developer";
  }

  NSString *simulatorKitPath = [
    developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
  ];
  void *simulatorKit = dlopen([simulatorKitPath fileSystemRepresentation], RTLD_NOW | RTLD_GLOBAL);
  if (!simulatorKit) {
    if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Could not load SimulatorKit from %@.", simulatorKitPath];
    return NULL;
  }

  dlopen(
    "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
    RTLD_NOW | RTLD_GLOBAL
  );

  RIIndigoMouseMessageFn messageFn =
    (RIIndigoMouseMessageFn)dlsym(simulatorKit, "IndigoHIDMessageForMouseNSEvent");
  if (!messageFn) {
    if (errorMessage) *errorMessage = @"SimulatorKit does not expose IndigoHIDMessageForMouseNSEvent.";
    return NULL;
  }

  Class serviceContextClass = NSClassFromString(@"SimServiceContext");
  if (!serviceContextClass) {
    if (errorMessage) *errorMessage = @"CoreSimulator SimServiceContext is unavailable.";
    return NULL;
  }

  id serviceContext = RIInvokeClassObjectError(
    serviceContextClass,
    @selector(sharedServiceContextForDeveloperDir:error:),
    developerDir
  );
  if (!serviceContext) {
    if (errorMessage) *errorMessage = @"Could not open the CoreSimulator service context.";
    return NULL;
  }

  id deviceSet = RIInvokeInstanceError(serviceContext, @selector(defaultDeviceSetWithError:));
  if (!deviceSet || ![deviceSet respondsToSelector:@selector(devices)]) {
    if (errorMessage) *errorMessage = @"Could not read the default Simulator device set.";
    return NULL;
  }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
  NSArray *devices = [deviceSet performSelector:@selector(devices)];
#pragma clang diagnostic pop

  id targetDevice = nil;
  for (id device in devices) {
    NSString *candidate = RIDeviceUDID(device);
    if ([candidate caseInsensitiveCompare:udid] == NSOrderedSame) {
      targetDevice = device;
      break;
    }
  }

  if (!targetDevice) {
    if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Simulator %@ was not found in CoreSimulator.", udid];
    return NULL;
  }

  Class clientClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
  if (!clientClass) {
    clientClass = objc_lookUpClass("_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
  }
  if (!clientClass) {
    if (errorMessage) *errorMessage = @"SimulatorKit HID client class is unavailable.";
    return NULL;
  }

  id client = RIInvokeInstanceObjectError(
    [clientClass alloc],
    @selector(initWithDevice:error:),
    targetDevice
  );
  if (!client) {
    if (errorMessage) *errorMessage = @"Could not create the Simulator HID client.";
    return NULL;
  }

  SEL sendSelector = @selector(sendWithMessage:freeWhenDone:completionQueue:completion:);
  NSMethodSignature *sendSignature = [client methodSignatureForSelector:sendSelector];
  if (!sendSignature) {
    [client release];
    if (errorMessage) *errorMessage = @"Simulator HID send method is unavailable.";
    return NULL;
  }

  RIHIDContext *context = calloc(1, sizeof(RIHIDContext));
  context->messageFn = messageFn;
  context->client = client;
  context->sendSelector = sendSelector;
  context->sendSignature = [sendSignature retain];
  context->udid = [udid copy];
  return context;
#endif
}

static BOOL RISendPointer(
  RIHIDContext *context,
  NSString *type,
  double x,
  double y,
  NSString **errorMessage
) {
  if (!context) {
    if (errorMessage) *errorMessage = @"Simulator HID is not prepared.";
    return NO;
  }

  x = fmax(0.0, fmin(1.0, x));
  y = fmax(0.0, fmin(1.0, y));

  int eventType = 0;
  int direction = 0;

  if ([type isEqualToString:@"down"]) {
    eventType = 1;
    direction = 1;
  } else if ([type isEqualToString:@"drag"]) {
    // SimulatorKit's Indigo builder returns NULL for NSEventTypeLeftMouseDragged.
    // A continued touch is represented by another mouse-down at the new point.
    eventType = 1;
    direction = 1;
  } else if ([type isEqualToString:@"up"]) {
    eventType = 2;
    direction = 2;
  } else {
    if (errorMessage) *errorMessage = @"Unsupported pointer event type.";
    return NO;
  }

  void *message = RICreateMessage(context->messageFn, x, y, eventType, direction);
  return RISendMessage(context, message, errorMessage);
}

int main(void) {
  @autoreleasepool {
    RIHIDContext *context = NULL;
    char *buffer = NULL;
    size_t capacity = 0;

    while (getline(&buffer, &capacity, stdin) != -1) {
      @autoreleasepool {
        NSString *line = [NSString stringWithUTF8String:buffer];
        NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *request = data
          ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil]
          : nil;

        NSNumber *requestId = [request objectForKey:@"id"] ?: @0;
        NSString *command = [request objectForKey:@"command"];

        if (![request isKindOfClass:[NSDictionary class]] || ![command isKindOfClass:[NSString class]]) {
          RIWriteResponse(requestId, NO, @"Invalid Simulator HID request.");
          continue;
        }

        if ([command isEqualToString:@"prepare"]) {
          NSString *udid = [request objectForKey:@"udid"];
          if (![udid isKindOfClass:[NSString class]] || ![udid length]) {
            RIWriteResponse(requestId, NO, @"A Simulator UDID is required.");
            continue;
          }

          if (context && [context->udid caseInsensitiveCompare:udid] == NSOrderedSame) {
            RIWriteResponse(requestId, YES, nil);
            continue;
          }

          RIDestroyContext(&context);
          NSString *errorMessage = nil;
          context = RICreateContext(udid, &errorMessage);
          RIWriteResponse(requestId, context != NULL, errorMessage);
          continue;
        }

        if ([command isEqualToString:@"pointer"]) {
          NSString *type = [request objectForKey:@"type"];
          NSNumber *x = [request objectForKey:@"x"];
          NSNumber *y = [request objectForKey:@"y"];
          NSString *errorMessage = nil;
          BOOL ok = RISendPointer(
            context,
            type,
            [x doubleValue],
            [y doubleValue],
            &errorMessage
          );
          RIWriteResponse(requestId, ok, errorMessage);
          continue;
        }

        RIWriteResponse(requestId, NO, @"Unknown Simulator HID command.");
      }
    }

    RIDestroyContext(&context);
    if (buffer) free(buffer);
  }

  return 0;
}
