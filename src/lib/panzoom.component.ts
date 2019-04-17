import { Component, OnInit, AfterViewInit, OnDestroy, ElementRef, ViewChild, Input, NgZone } from '@angular/core';
import { PanZoomConfig } from './panzoom-config';
import { Point } from './panzoom-point';
import { PanZoomModel } from './panzoom-model';
import { PanZoomAPI } from './panzoom-api';
import { Rect } from './panzoom-rect';
import { throttle } from 'lodash';
declare var $: any;

/*
var oldAddEventListener = EventTarget.prototype.addEventListener;

EventTarget.prototype.addEventListener = function(eventName, eventHandler: any, options: any = null)
{
  console.log('eventName:', eventName);
  oldAddEventListener.call(this, eventName, function(event) {
    eventHandler(event);
  }, options);
};
*/

interface ZoomAnimation {
  deltaZoomLevel: number;
  panStepFunc: Function;
  duration: number;
  progress: number;
}

interface Position {
  x?: number;
  y?: number;
  length?: number;
}

@Component( {
  // tslint:disable-next-line:component-selector
  selector: 'pan-zoom',
  // we don't want to kill change detection for all elements beneath this, so we don't set OnPush.  Child views can implement OnPush if the developer wants to.  We can get away with this because the kwheel directive runs outside of Angular, so it doesnt trigger change detection.
  template: `
<div #frameElement class="pan-zoom-frame" style="position:relative; width: 100%; height: 100%; overflow: hidden;">
  <div #panElement class="panElement" style="position: absolute; left: 0px; top: 0px;">
    <div #zoomElement class="zoomElement">
      <ng-content></ng-content>
    </div>
  </div>
</div>
<div #panzoomOverlay style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; opacity: 0; display: none; pointer-events: none;"></div>
  `
} )

export class PanZoomComponent implements OnInit, AfterViewInit, OnDestroy {

  constructor ( private el: ElementRef,
                private zone: NgZone ) {}

  @ViewChild('frameElement') private frameElementRef: ElementRef;
  @ViewChild('panElement') private panElementRef: ElementRef;
  @ViewChild('zoomElement') private zoomElementRef: ElementRef;
  @ViewChild('panzoomOverlay') private panzoomOverlayRef: ElementRef;

  @Input() private config: PanZoomConfig;

  private base: PanZoomModel; // this is what the pan/zoom view is before a zoom animation begins and after it ends.  It also updates with every mouse drag or freeZoom
  private model: PanZoomModel; // this is used for incremental changes to the pan/zoom view during each animation frame.  Setting it will update the pan/zoom coordinates on the next call to updateDOM().  Not used during mouse drag or freeZoom
  private api: PanZoomAPI;
  private contentHeight: number;
  private contentWidth: number;
  private frameHeight: number;
  private frameWidth: number;
  private lastMouseEventTime: number;
  private previousPosition: Position = null;
  private isDragging = false;
  private panVelocity: Point = null;
  private animationParams: ZoomAnimation = null;
  private frameElement: JQuery;
  private animationFrameFunc: Function; // reference to the appropriate getAnimationFrame function for the client browser
  private lastTick = 0;
  private isChrome = false;
  private willChangeNextFrame = true; // used for scaling in Chrome
  private animationId: number;
  private isMobile = false;
  private scale: number;
  private isFirstSync = true;
  private lastClickPoint: Point;
  private acceleratedFrameRef: any;
  private zoomLevelIsChanging = false;
  private dragFinishing = false;
  private dragMouseButton: number = null;

  private maxScale: number; // the highest scale (furthest zoomed in) that we will allow in free zoom mode (calculated)
  private minScale: number; // the smallest scale (furthest zoomed out) that we will allow in free zoom mode (calculated)
  private minimumAllowedZoomLevel: number;



  ngOnInit(): void {
    // console.log('PanZoomComponent: ngOnInit(): initializing PanZoomComponent');

    if (this.config.initialZoomToFit) {
      this.base = this.calcZoomToFit(this.config.initialZoomToFit);
    }
    else {
      this.base = {
        zoomLevel: this.config.initialZoomLevel,
        pan: {
          x: this.config.initialPanX,
          y: this.config.initialPanY
        }
      };
    }

    this.model = {
      zoomLevel: this.base.zoomLevel,
      isPanning: false, // Only true if panning is actually taking place, not just after mousedown
      pan: {
        x: this.base.pan.x,
        y: this.base.pan.y
      }
    };

    this.config.modelChanged.next(this.model);

    // create public API
    this.api = {
      model: this.model,
      config: this.config,
      changeZoomLevel: this.zoomToLevelAndPoint.bind(this),
      zoomIn: this.zoomInToLastClickPoint.bind(this),
      zoomOut: this.zoomOutFromLastClickPoint.bind(this),
      zoomToFit: this.zoomToFit.bind(this),
      resetView: this.resetView.bind(this),
      getViewPosition: this.getViewPosition.bind(this),
      getModelPosition: this.getModelPosition.bind(this),
      panToPoint: this.panToPoint.bind(this),
      panDelta: this.panDelta.bind(this),
      panDeltaPercent: this.panDeltaPercent.bind(this),
      panDeltaAbsolute: this.panDeltaAbsolute.bind(this),
      freeze: this.freeze.bind(this)
    };

    this.config.api.next(this.api);

    if (this.config.freeMouseWheel) {
      this.scale = this.getCssScale(this.config.initialZoomLevel);
      let maxZoomLevel = this.config.zoomLevels - 1;
      this.maxScale = this.getCssScale(maxZoomLevel);
      this.minScale = this.getCssScale(0);
    }

    this.minimumAllowedZoomLevel = 0;
    if (this.config.keepInBounds) {
      this.minimumAllowedZoomLevel = this.config.neutralZoomLevel;
      this.minScale = this.getCssScale(this.config.neutralZoomLevel);
    }

    this.acceleratedFrameRef = this.zoomElementRef;
    // console.log('frameHeight:', this.frameHeight);
    // console.log('frameWidth:', this.frameWidth);

    (<any>this.acceleratedFrameRef.nativeElement.style).willChange = 'transform';
    if (navigator.userAgent.search('Chrome') >= 0) {
      this.isChrome = true;
      this.acceleratedFrameRef.nativeElement.style.transform = 'translateZ(0)';
    }

    this.animationTick(performance.now());
    this.scale = this.getCssScale(this.base.zoomLevel);
    this.isFirstSync = false;
    switch (this.config.dragMouseButton) {
      case 'left':
        this.dragMouseButton = 0;
        break;
      case 'middle':
        this.dragMouseButton = 1;
        this.zone.runOutsideAngular( () => this.frameElementRef.nativeElement.addEventListener('auxclick', this.preventDefault ) );
        break;
      case 'right':
        this.zone.runOutsideAngular( () => document.addEventListener('contextmenu', this.preventDefault ) );
        this.dragMouseButton = 2;
        break;
      default:
        this.dragMouseButton = 0; // left
    }


  }



  ngAfterViewInit(): void {
    // console.log('PanZoomComponent: ngAfterViewInit()');

    this.frameElement = $('.pan-zoom-frame');
    this.contentHeight = $('.zoomElement').children().height();
    this.contentWidth = $('.zoomElement').children().width();
    this.frameHeight = this.frameElement.height();
    this.frameWidth = this.frameElement.width();

    this.zone.runOutsideAngular( () => this.animationFrameFunc = window.requestAnimationFrame );
    // this.zone.runOutsideAngular( () => this.wheelAnimationFrameFunc = window.requestAnimationFrame );

    const handleMouseWheel = throttle((event) => {
      this.animationFrameFunc( () => this.onMouseWheel(event));
    }, 30);

    if (this.isMobileDevice()) {
      this.isMobile = true;
      this.zone.runOutsideAngular( () => this.frameElementRef.nativeElement.addEventListener('touchstart', this.onTouchStart ) );
    }
    else {
      this.zone.runOutsideAngular( () => this.frameElementRef.nativeElement.addEventListener('mousedown', this.onMousedown ) );
      this.zone.runOutsideAngular( () => this.frameElementRef.nativeElement.addEventListener('dblclick', this.onDblClick ) );
      this.zone.runOutsideAngular( () => {
        this.frameElementRef.nativeElement.addEventListener('wheel', (event) => {
          event.preventDefault();
          handleMouseWheel(event);
        });
      });
    }

  }



  ngOnDestroy(): void {
    // console.log('PanZoomComponent: ngOnDestroy()');
    if (this.isMobile) {
      this.frameElementRef.nativeElement.removeEventListener('touchstart', this.onTouchStart);
    }
    else {
      this.frameElementRef.nativeElement.removeEventListener('mousedown', this.onMousedown);
      this.frameElementRef.nativeElement.removeEventListener('wheel', (event) => this.animationFrameFunc( () => this.onMouseWheel(event) ), { passive: true } );
      this.frameElementRef.nativeElement.removeEventListener('dblclick', this.onDblClick);
    }
    if (this.animationFrameFunc && this.animationId) {
      window.cancelAnimationFrame(this.animationId);
    }
    switch (this.config.dragMouseButton) {
      case 'middle':
        this.dragMouseButton = 1;
        this.zone.runOutsideAngular( () => this.frameElementRef.nativeElement.removeEventListener('auxclick', this.preventDefault ) );
        break;
      case 'right':
        this.zone.runOutsideAngular( () => document.removeEventListener('contextmenu', this.preventDefault ) );
        this.dragMouseButton = 2;
        break;
    }
  }



  //////////////////////////// END OF LIFECYCLE HOOKS ////////////////////////////








  ////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////// EVENT HANDLERS ///////////////////////////////
  ////////////////////////////////////////////////////////////////////////////////



  private onMouseWheel = (event: WheelEvent) => {
    // console.log('PanZoomComponent: OnMouseWheel() event:', event);

    // let event = e.event;
    let deltaY = event.deltaY;

    if (this.config.zoomOnMouseWheel) {
      // event.preventDefault();

      if (this.animationParams) {
        return; // already zooming
      }

      if (this.config.invertMouseWheel || event.ctrlKey) {
        deltaY = -deltaY;
      }

      if (event.ctrlKey) {
        deltaY *= this.config.freeMousePinchWheelMultiplier;
      }

      // console.log('deltaY:', event.deltaY);

      // let sign = event.deltaY / Math.abs(event.deltaY);

      let clickPoint: Point = {
        x: event.pageX - this.frameElement.offset().left,
        y: event.pageY - this.frameElement.offset().top
      };

      this.lastClickPoint = clickPoint;

      if (this.config.freeMouseWheel) {
        // free wheel scroll
        this.freeZoom(clickPoint, deltaY);
      }
      else {
        // let sign = Math.sign(event.deltaY);
        if (deltaY < 0) {
          this.zoomIn(clickPoint);
        }
        else if (deltaY > 0) {
          this.zoomOut(clickPoint);
        }
      }
    }
  }



  private onMousedown = (event: any) => {
    // console.log('PanZoomComponent: onMousedown()', event);

    if (this.animationParams) {
      return;
    }

    if (event.button === this.dragMouseButton || event.type === 'touchstart') {
      event.preventDefault();
      // event.stopPropagation();

      this.dragFinishing = false;
      this.panVelocity = null;

      const pageX = event.pageX || event.changedTouches[0].pageX;
      const pageY = event.pageY || event.changedTouches[0].pageY;

      if (this.config.panOnClickDrag) {
        this.previousPosition = {
          x: pageX,
          y: pageY
        };
        this.lastMouseEventTime = event.timeStamp;
        this.isDragging = true;
        this.model.isPanning = false;

        setTimeout(() => {
          if (this.isMobile) {
            this.zone.runOutsideAngular( () => document.addEventListener('touchend', this.onTouchEnd, false ) ); // leave this on document
            this.zone.runOutsideAngular( () => document.addEventListener('touchmove', this.onTouchMove, { passive: true, capture: false } ) ); // leave this on document
          }
          else {
            this.zone.runOutsideAngular( () => document.addEventListener('mousemove', this.onMouseMove, { passive: true, capture: false } ) ); // leave this on document
            this.zone.runOutsideAngular( () => document.addEventListener('mouseup', this.onMouseUp ) ); // leave this on document
          }
        });
      }

      return false;
    }
  }


  freeze() {
    this.isDragging = false;
    this.model.isPanning = false;

    if (this.isMobile) {
      this.zone.runOutsideAngular( () => document.removeEventListener('touchend', this.onTouchEnd) );
      this.zone.runOutsideAngular( () => document.removeEventListener('touchmove', this.onTouchMove, <any>{ passive: true, capture: false } ) );
    }
    else {
      this.zone.runOutsideAngular( () => document.removeEventListener('mousemove', this.onMouseMove, <any>{ passive: true, capture: false } ));
      this.zone.runOutsideAngular( () => document.removeEventListener('mouseup', this.onMouseUp, <any>{ passive: true } ));
    }
  }



  private onTouchStart = (event: TouchEvent) => {
    // console.log('PanZoomComponent: onTouchStart()', event);
    // console.log('PanZoomComponent: onTouchStart(): touches:', event.touches.length);

    event.preventDefault();

    if (this.animationParams) {
      return;
    }
    // event.stopPropagation();

    if (event.touches.length !== 1) {
      // multiple touches, get ready for zooming

      // Calculate x and y distance between touch events
      let x = event.touches[0].pageX - event.touches[1].pageX;
      let y = event.touches[0].pageY - event.touches[1].pageY;

      // Calculate length between touch points with pythagoras
      // There is no reason to use Math.pow and Math.sqrt as we
      // only want a relative length and not the exact one.
      this.previousPosition = {
        length: x * x + y * y
      };
    }
    this.onMousedown(event);
  }



  private onMouseMove = (event: any) => {
    // console.log('PanZoomComponent: onMouseMove()', event);
    // console.log(`PanZoomComponent: onMouseMove(): event.timeStamp:`, event.timeStamp);
    // timestamp - 10587.879999999132 - milliseconds
    // Called when moving the mouse with the left button down

    // event.preventDefault();
    // event.stopPropagation();

    let now = event.timeStamp;
    let timeSinceLastMouseEvent = (now - this.lastMouseEventTime) / 1000; // orig
    // let timeSinceLastMouseEvent = (now - this.lastMouseEventTime);

    if (!timeSinceLastMouseEvent || this.animationParams) {
      return;
    }

    this.lastMouseEventTime = now;

    const pageX = event.pageX || event.changedTouches[0].pageX;
    const pageY = event.pageY || event.changedTouches[0].pageY;

    let dragDelta = {
      // a representation of how far each coordinate has moved since the last time it was moved
      x: pageX - this.previousPosition.x,
      y: pageY - this.previousPosition.y
    };

    if (this.config.keepInBounds) {
      let topLeftCornerView = this.getViewPosition( { x: 0, y: 0 } );
      let bottomRightCornerView = this.getViewPosition( { x: this.contentWidth, y: this.contentHeight } );


      if (topLeftCornerView.x > 0 && dragDelta.x > 0) {
        dragDelta.x *= Math.min(1,
                                Math.pow(topLeftCornerView.x, -this.config.keepInBoundsDragPullback)
                               );
      }

      if (topLeftCornerView.y > 0 && dragDelta.y > 0) {
        dragDelta.y *= Math.min(1,
                                  Math.pow(topLeftCornerView.y, -this.config.keepInBoundsDragPullback)
                                );
      }

      if (bottomRightCornerView.x < this.contentWidth && dragDelta.x < 0) {
        dragDelta.x *= Math.min(1,
                                  Math.pow(this.contentWidth - bottomRightCornerView.x, -this.config.keepInBoundsDragPullback)
                               );
      }

      if (bottomRightCornerView.y < this.contentHeight && dragDelta.y < 0) {
        dragDelta.y *= Math.min(1,
                                 Math.pow(this.contentHeight - bottomRightCornerView.y, -this.config.keepInBoundsDragPullback)
                               );
      }
    }

    // now pan the view
    let delta: Point = {
      x: dragDelta.x || 0,
      y: dragDelta.y || 0
    };
    this.model.pan.x += delta.x;
    this.model.pan.y += delta.y;
    this.syncBaseToModel();
    this.animationTick(performance.now());

    if (!this.model.isPanning) {
      // This will improve the performance,
      // because the browser stops evaluating hits against the elements displayed inside the pan zoom view.
      // Besides this, mouse events will not be sent to any other elements,
      // this prevents issues like selecting elements while dragging.
      this.panzoomOverlayRef.nativeElement.style.display = 'block';
    }

    this.model.isPanning = true;

    // set these for the animation slow down once drag stops
    // panVelocity is a measurement of speed for x and y coordinates, in pixels per mouse move event.  It is a measure of how fast the mouse is moving
    this.panVelocity = {
      x: dragDelta.x / timeSinceLastMouseEvent,
      y: dragDelta.y / timeSinceLastMouseEvent
    };
    // console.log(`PanZoomComponent: onMouseMove(): panVelocity:`, this.panVelocity);

    this.previousPosition = {
      x: pageX,
      y: pageY
    };

  }



  private onTouchMove = (event: any) => {
    console.log('PanZoomComponent: onTouchMove()');
    console.log('PanZoomComponent: onTouchMove(): event:', event);

    // event.preventDefault();
    // event.stopPropagation();
    if (this.animationParams) {
      return;
    }

    if (event.touches.length === 1) {
      // single touch, emulate mouse move
      this.onMouseMove(event);
    }
    else {
      // multiple touches, zoom in/out
      console.log('pinch zooming');

      // Calculate x and y distance between touch events
      let x = event.touches[0].pageX - event.touches[1].pageX;
      let y = event.touches[0].pageY - event.touches[1].pageY;
      // Calculate length between touch points with pythagoras
      // There is no reason to use Math.pow and Math.sqrt as we
      // only want a relative length and not the exact one.
      let length = x * x + y * y;

      // Calculate delta between current position and last position
      let delta = length - this.previousPosition.length;

      // Naive hysteresis
      if (Math.abs(delta) < 100) {
        return;
      }

      // Calculate center between touch points
      let centerX = event.touches[1].pageX + x / 2;
      let centerY = event.touches[1].pageY + y / 2;

      // Calculate zoom center
      let clickPoint = {
        x: centerX - this.frameElement.offset().left,
        y: centerY - this.frameElement.offset().top
      };
      this.lastClickPoint = clickPoint;

      this.changeZoomLevel( this.base.zoomLevel + delta * 0.00001, clickPoint, 0.01);
      // this.freeZoom( clickPoint, delta);

      // Update length for next move event
      this.previousPosition = {
        length: length
      };
    }
  }



  private onMouseUp = (event) => {
    // console.log('PanZoomComponent: onMouseup()', event);

    if (this.animationParams) {
      return this.freeze();
    }

    if (event.button !== this.dragMouseButton && event.type !== 'touchend') {
      return;
    }

    event.preventDefault();
    // event.stopPropagation();

    let now = event.timeStamp;
    let timeSinceLastMouseEvent = (now - this.lastMouseEventTime) / 1000; // orig

    if (this.panVelocity && (this.panVelocity.x !== 0 || this.panVelocity.y !== 0) ) {
      // apply strong initial dampening if the mouse up occured much later than the last mouse move, indicating that the mouse hasn't moved recently
      // TBD - experiment with this formula
      let initialMultiplier = Math.max(
        0,
        -0.2 + Math.pow(timeSinceLastMouseEvent + 1, -4)
        );

        this.panVelocity.x *= initialMultiplier;
        this.panVelocity.y *= initialMultiplier;
        this.dragFinishing = true;
        // console.log(`PanZoomComponent: onMouseUp(): panVelocity:`, this.panVelocity);
        this.zone.runOutsideAngular( () => this.animationId = this.animationFrameFunc(this.animationTick) );
      }
      else {
        this.dragFinishing = false;
        this.panVelocity = null;
      }

      this.isDragging = false;
      // this.model.isPanning = false;

      if (this.isMobile) {
        this.zone.runOutsideAngular( () => document.removeEventListener('touchend', this.onTouchEnd) );
        this.zone.runOutsideAngular( () => document.removeEventListener('touchmove', this.onTouchMove, <any>{ passive: true, capture: false } ) );
      }
      else {
        this.zone.runOutsideAngular( () => document.removeEventListener('mousemove', this.onMouseMove, <any>{ passive: true, capture: false } ));
        this.zone.runOutsideAngular( () => document.removeEventListener('mouseup', this.onMouseUp, <any>{ passive: true } ));
    }

    // Set the overlay to non-blocking again:
    this.panzoomOverlayRef.nativeElement.style.display = 'none';
  }



  private onTouchEnd = (event: any) => {
    // console.log('PanZoomComponent: onTouchEnd()');
    this.onMouseUp(event);
  }



  private onDblClick = (event: any) => {
    // console.log('PanZoomComponent: onDblClick()');
    event.preventDefault();
    // event.stopPropagation();
    if (!this.config.zoomOnDoubleClick) {
      return;
    }

    let clickPoint: Point = {
      x: event.pageX - this.frameElement.offset().left,
      y: event.pageY - this.frameElement.offset().top
    };
    this.lastClickPoint = clickPoint;
    this.zoomIn(clickPoint);
  }



  private preventDefault = (event: any) => {
    event.preventDefault();
  }




  ////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////// END EVENT HANDLERS ///////////////////////////////
  ////////////////////////////////////////////////////////////////////////////////










  ////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////// APPLY ANIMATIONS /////////////////////////////////
  ////////////////////////////////////////////////////////////////////////////////



  private animationTick = (timestamp: number) => {
    // console.log('PanZoomComponent: animationTick()');
    // timestamp looks like 76916.963.  The unit is milliseconds and should be accurate to 5 µs (microseconds)

    let deltaTime = 0;
    if (this.lastTick !== 0) {
      deltaTime = (timestamp - this.lastTick); // orig - milliseconds since the last animationTick
    }
    this.lastTick = timestamp;

    if (this.animationParams) {
      // when we're running an animation (but not waiting for a released drag to halt)
      // console.log('PanZoomComponent: animationTick(): model is zooming');

      this.animationParams.progress += Math.abs(deltaTime / this.animationParams.duration);

      if (this.animationParams.progress >= 1.0) {
        // Only when the animation has finished, sync the base to the model.
        this.animationParams.progress = 1.0;
        this.updateDOM();
        this.animationParams = null;
      }
    }

    if (this.panVelocity && this.dragFinishing) {
      // This is when we've panned and released the mouse button and the view is "free-floating" until it slows to a halt.  Don't let the while loop fool you - this only applies it for the current frame.
      // Prevent overshooting if delta time is large for some reason. We apply the simple solution of slicing delta time into smaller pieces and applying each one
      if (deltaTime > 0) {
        deltaTime = deltaTime / 1000;
      }
      while (deltaTime > 0) {
        let dTime = Math.min(.02, deltaTime);
        deltaTime = deltaTime - dTime;

        this.model.pan.x = this.model.pan.x + this.panVelocity.x * dTime;
        this.panVelocity.x = this.panVelocity.x * (1 - this.config.friction * dTime);

        this.model.pan.y = this.model.pan.y + this.panVelocity.y * dTime;
        this.panVelocity.y = this.panVelocity.y * (1 - this.config.friction * dTime);

        let speed = this.length(this.panVelocity);

        if (speed < this.config.haltSpeed) {
          this.model.isPanning = false;
          this.panVelocity = null;
          this.dragFinishing = false;
          break;
        }

      }
    }

    if (this.config.keepInBounds || this.dragFinishing) {
      // Checks that keepInBounds is set and that the mouse button isn't pressed, and if so, it stops the contents from going out of view
      // console.log('PanZoomComponent: animationTick(): keepInBounds');
      let topLeftCornerView = this.getViewPosition({ x: 0, y: 0 });
      let bottomRightCornerView = this.getViewPosition({ x: this.contentWidth, y: this.contentHeight });

      if (topLeftCornerView.x > 0) {
        this.base.pan.x -= this.config.keepInBoundsRestoreForce * topLeftCornerView.x;
      }

      if (topLeftCornerView.y > 0) {
        this.base.pan.y -= this.config.keepInBoundsRestoreForce * topLeftCornerView.y;
      }

      if (bottomRightCornerView.x < this.contentWidth) {
        this.base.pan.x -= this.config.keepInBoundsRestoreForce * (bottomRightCornerView.x - this.contentWidth);
      }

      if (bottomRightCornerView.y < this.contentHeight) {
        this.base.pan.y -= this.config.keepInBoundsRestoreForce * (bottomRightCornerView.y - this.contentHeight);
      }
    }

    this.updateDOM();
    this.config.modelChanged.next(this.model);


    if ( this.animationParams || (this.panVelocity && this.dragFinishing) ) {
      // Are we in an animation?  If so, run the next frame

      if (this.isChrome && this.zoomLevelIsChanging) {
        // run will-change toggle hack on Chrome to trigger re-rasterization
        // see https://developers.google.com/web/updates/2016/09/re-rastering-composite
        if (this.willChangeNextFrame) {
          (<any>this.acceleratedFrameRef.nativeElement.style).willChange = 'auto';
        }
        else {
          (<any>this.acceleratedFrameRef.nativeElement.style).willChange = 'transform';
        }
        this.willChangeNextFrame = !this.willChangeNextFrame;
      }
      // console.log('calling next tick');
      this.animationFrameFunc(this.animationTick); // Call the next animation frame
    }
    else if (this.panVelocity && !this.dragFinishing) {
      // we're just mouse-panning the frame.  We don't need another tick
      return;
    }
    else {
      // Animation has ended
      this.syncBaseToModel();
      this.scale = this.getCssScale(this.base.zoomLevel);
      this.willChangeNextFrame = true;
      (<any>this.acceleratedFrameRef.nativeElement.style).willChange = 'transform';
      this.zoomLevelIsChanging = false;
      this.lastTick = 0;
    }

  }



  private updateDOM() {
    // console.log('PanZoomComponent: updateDOM()');
    // Called by ngAfterViewInit() and animationTick()
    // This function does not get called by freeZoom(), which operates independently of animationTick() and updateDOM().

    if (this.animationParams) {
      // we're running an animation sequence (but not freeZooming or panning with onMouseMove() )
      this.model.zoomLevel = this.base.zoomLevel + this.animationParams.deltaZoomLevel * this.animationParams.progress; // calculate how far we need to zoom in or out for the current animationTick
      let deltaTranslation = this.animationParams.panStepFunc(this.model.zoomLevel); // calculate how far to pan the view to based on our translated coordinates

      // sync the model pan coordinates to our translated pan coordinates
      // we do this by adding how far we want to move in each direction to our our existing base pan coordinates (where we started)
      this.model.pan.x = this.base.pan.x + deltaTranslation.x;
      this.model.pan.y = this.base.pan.y + deltaTranslation.y;

      if (this.config.keepInBounds) {
        let topLeftCornerView = this.getViewPosition({ x: 0, y: 0 });
        let bottomRightCornerView = this.getViewPosition({ x: this.contentWidth, y: this.contentHeight });

        if (topLeftCornerView.x > 0) {
          this.model.pan.x = 0;
        }

        if (topLeftCornerView.y > 0) {
          this.model.pan.y = 0;
        }

        if (bottomRightCornerView.x < this.contentWidth) {
          this.model.pan.x -= (bottomRightCornerView.x - this.contentWidth);
        }

        if (bottomRightCornerView.y < this.contentHeight) {
          this.model.pan.y -= (bottomRightCornerView.y - this.contentHeight);
        }
      }
    }

    ////////////////////////////////////////////////////
    //////////////////// APPLY SCALING /////////////////
    ////////////////////////////////////////////////////
    if (this.animationParams || this.isFirstSync) {
      let scale = this.getCssScale(this.model.zoomLevel);
      let scaleString = `scale3d(${scale}, ${scale}, ${scale})`;
      this.zoomElementRef.nativeElement.style.transformOrigin = '0 0';
      this.zoomElementRef.nativeElement.style.transform = scaleString;
    }

    ////////////////////////////////////////////////////
    //////////////// APPLY PAN ANIMATION ///////////////
    ////////////////////////////////////////////////////
    let translate3d = `translate3d(${this.model.pan.x}px, ${this.model.pan.y}px, 0)`;
    this.panElementRef.nativeElement.style.transform = translate3d;

  }



  private freeZoom(clickPoint: Point, wheelDelta: number): void {
    // console.log('PanZoomComponent: freeZoom(): this.base:', this.base);

    if (this.isDragging) {
      // don't allow zooming if the mouse is down
      return;
    }

    // now handle interruption of an in-progress animation
    if (this.animationParams) {
      this.animationParams = null; // cancel an existing animation
    }

    if (this.panVelocity) {
      this.dragFinishing = false;
      this.panVelocity = null;
    }

    let currentPan: Point = {
      // the current base coordinates
      x: this.base.pan.x,
      y: this.base.pan.y
    };
    let currentScale = this.scale; // get the current CSS scale (scale0)

    let newScale = this.scale + (wheelDelta * this.config.freeMouseWheelFactor * this.scale);

    // takes either the minimum scale (furthest allowable zoomed out) or the calculated current scale, whichever is greater, unless calculated current scale exceeds maxScale (furthest allowable zoomed in), in which case maxScale is used
    newScale = Math.max(this.minScale, Math.min( this.maxScale, newScale ));
    this.scale = newScale;

    let targetPoint: Point = {
      // The target point to zoom to.  It must stay the same as the untranslated point
      x: clickPoint.x - (newScale / currentScale) * (clickPoint.x - currentPan.x),
      y: clickPoint.y - (newScale / currentScale) * (clickPoint.y - currentPan.y)
    };

    // Apply Pan & Scale
    let translate3d = `translate3d(${targetPoint.x}px, ${targetPoint.y}px, 0)`;
    this.panElementRef.nativeElement.style.transform = translate3d;
    let scaleString = `scale(${this.scale})`;
    this.zoomElementRef.nativeElement.style.transformOrigin = '0 0';
    this.zoomElementRef.nativeElement.style.transform = scaleString;

    if (this.isChrome) {
      if (this.willChangeNextFrame) {
        (<any>this.acceleratedFrameRef.nativeElement.style).willChange = 'auto';
      }
      else {
        (<any>this.acceleratedFrameRef.nativeElement.style).willChange = 'transform';
      }
      this.willChangeNextFrame = !this.willChangeNextFrame;
    }

    this.model.pan.x = targetPoint.x;
    this.model.pan.y = targetPoint.y;
    this.model.zoomLevel = this.getZoomLevel(this.scale);
    this.syncBaseToModel();
    this.config.modelChanged.next(this.model);
    // console.log(`PanZoomComponent: freeZoom(): baseAfterZoom: x: ${this.base.pan.x} y: ${this.base.pan.y} zoomlevel: ${this.base.zoomLevel}` );
    // console.log('zoomLevel:', this.base.zoomLevel);
  }






  ////////////////////////////////////////////////////
  //////////////// HELPER FUNCTIONS //////////////////
  ////////////////////////////////////////////////////



  private isMobileDevice(): boolean {
    return (typeof window.orientation !== 'undefined') || (navigator.userAgent.indexOf('IEMobile') !== -1);
  }




  private syncBaseToModel() {
    this.base.pan.x = this.model.pan.x;
    this.base.pan.y = this.model.pan.y;
    this.base.zoomLevel = this.model.zoomLevel;
  }



  private length(vector2d: any) {
    // console.log('PanZoomComponent: length()');
    return Math.sqrt(vector2d.x * vector2d.x + vector2d.y * vector2d.y);
  }



  private getCenterPoint(): Point {
    // console.log('PanZoomComponent: getCenterPoint()');
    // console.log('PanZoomComponent: getCenterPoint(): projectedContentRef:', this.projectedContentRef);
    let center = {
      // x: this.frameElement.width() / 2,
      x: this.frameElementRef.nativeElement.offsetWidth / 2,
      // x: this.projectedContentRef.nativeElement.offsetWidth / 2,
      // y: this.frameElement.height() / 2
      y: this.frameElementRef.nativeElement.offsetHeight / 2
      // y: this.projectedContentRef.nativeElement.offsetHeight / 2
    };
    return center;
  }



  private getCssScale(zoomLevel: any): number {
    // console.log('PanZoomComponent: getCssScale()');
    return Math.pow(this.config.scalePerZoomLevel, zoomLevel - this.config.neutralZoomLevel);
  }



  private getZoomLevel(cssScale: any) {
    // console.log('PanZoomComponent: getZoomLevel()');
    return Math.log10(cssScale) / Math.log10(this.config.scalePerZoomLevel) + this.config.neutralZoomLevel;
  }



  private calcZoomToFit(rect: Rect): PanZoomModel {
    // console.log('PanZoomComponent: calcZoomToFit(): rect:', rect);
    // let (W, H) denote the size of the viewport
    // let (w, h) denote the size of the rectangle to zoom to
    // then we must CSS scale by the min of W/w and H/h in order to just fit the rectangle
    // returns the target left and top coordinates for the panElement and target zoomLevel

    let viewportWidth = this.frameElementRef.nativeElement.offsetWidth;
    let viewportHeight = this.frameElementRef.nativeElement.offsetHeight;

    let targetWidth = rect.width;
    let targetHeight = rect.height;

    let cssScaleExact = Math.min( viewportWidth / targetWidth, viewportHeight / targetHeight );
    let zoomLevelExact = this.getZoomLevel(cssScaleExact);
    let zoomLevel = zoomLevelExact * this.config.zoomToFitZoomLevelFactor;
    let cssScale = this.getCssScale(zoomLevel);

    return {
        zoomLevel: zoomLevel,
        pan: {
            x: -rect.x * cssScale + (viewportWidth - targetWidth * cssScale) / 2,
            y: -rect.y * cssScale + (viewportHeight - targetHeight * cssScale) / 2
        }
    };
  }



  private zoomToFitModel(target: PanZoomModel, duration: number = null) {
    // console.log('PanZoomComponent: zoomToFitModel(): target:', target);

    // target.pan.x is the panElement left style property
    // target.pan.y is the panElement top style property
    this.animateToTarget(target, duration);
  }



  private zoomToLevelAndPoint(level: number, clickPoint: Point) {
    // console.log('PanZoomComponent: zoomToLevelAndPoint(): level:', level);
    // console.log('PanZoomComponent: zoomToLevelAndPoint(): clickPoint:', clickPoint);
    this.changeZoomLevel( level, clickPoint );
  }



  private zoomInToLastClickPoint() {
    // console.log('PanZoomComponent: zoomInToLastClickPoint(): lastClickPoint', this.lastClickPoint);
    this.changeZoomLevel( this.base.zoomLevel + this.config.zoomButtonIncrement, this.lastClickPoint );
  }



  private zoomOutFromLastClickPoint() {
    // console.log('PanZoomComponent: zoomOutFromLastClickPoint()');
    this.changeZoomLevel( this.base.zoomLevel - this.config.zoomButtonIncrement, this.lastClickPoint );
  }



  private startAnimation() {
    this.lastTick = performance.now();
    this.zone.runOutsideAngular( () => this.animationId = this.animationFrameFunc(this.animationTick) );
  }







  ////////////////////////////////////////////////////
  /////////////////// API METHODS ////////////////////
  ////////////////////////////////////////////////////



  private getViewPosition(modelPosition: Point): Point {
    // console.log('PanZoomComponent: getViewPosition()');
    // p' = p * s + t
    // viewPosition = modelPosition * scale + basePan

    let scale, translation;

    if (this.animationParams) {
      scale = this.getCssScale(this.base.zoomLevel + this.animationParams.deltaZoomLevel * this.animationParams.progress);
      let deltaTranslation = this.animationParams.panStepFunc(this.model.zoomLevel);
      translation = { x: this.base.pan.x + deltaTranslation.x, y: this.base.pan.y + deltaTranslation.y };
    }
    else {
      scale = this.getCssScale(this.base.zoomLevel);
      translation = this.base.pan;
    }

    return {
      x: modelPosition.x * scale + translation.x,
      y: modelPosition.y * scale + translation.y
    };
  }



  private getModelPosition(viewPosition: Point) {
    // console.log('PanZoomComponent: getModelPosition()');
    // p = (1/s)(p' - t)
    let pmark = viewPosition;
    let s = this.getCssScale(this.base.zoomLevel);
    let t = this.base.pan;

    return {
      x: (1 / s) * (pmark.x - t.x),
      y: (1 / s) * (pmark.y - t.y)
    };
  }



  private resetView() {
    // console.log('PanZoomComponent: resetView()');
    if (this.config.initialZoomToFit) {
      this.zoomToFit(this.config.initialZoomToFit);
    }
    else if (this.config.initialPanX !== null && this.config.initialPanY !== null && this.config.initialZoomLevel !== null) {
      this.zoomToFitModel(
        {
          zoomLevel: this.config.initialZoomLevel,
          pan: {
            x: this.config.initialPanX,
            y: this.config.initialPanY
          }
        }
      );
    }
    else {
      console.error('PanZoomComponent: resetView() could not reset view as some vars were not set.  The culprits are either config.initialZoomLevel, config.initialPanX, or config.initialPanY.  Or just set panzoomConfig.initialZoomToFit');
      console.log('config.initialZoomLevel: ' + this.config.initialZoomLevel);
      console.log('config.initialPanX: ' + this.config.initialPanX);
      console.log('config.initialPanY: ' + this.config.initialPanY);
    }
  }



  private zoomToFit(rectangle: Rect, duration: number = null) {
    // console.log('PanZoomComponent: zoomToFit(): rectangle', rectangle);

    // when a user clicks a zoom to fit button
    // example rectangle: { "x": 0, "y": 100, "width": 100, "height": 100 }

    let target: PanZoomModel = this.calcZoomToFit(rectangle);
    // target.pan.x is the panElement left style property
    // target.pan.y is the panElement top style property
    this.animateToTarget(target, duration);
  }



  private zoomIn(clickPoint: Point) {
    // console.log('PanZoomComponent: zoomIn(): clickPoint:', clickPoint);
    this.changeZoomLevel( this.base.zoomLevel + this.config.zoomButtonIncrement, clickPoint );
  }



  private zoomOut(clickPoint: Point) {
    // console.log('PanZoomComponent: zoomOut()');
    this.changeZoomLevel( this.base.zoomLevel - this.config.zoomButtonIncrement, clickPoint );
  }



  private panToPoint(point: Point, duration: number = null) {
    // console.log('PanZoomComponent: panToPoint(): point:', point);

    // API call to animate the view so that the centre point of the view is at the
    // point parameter coordinates, relative to the original, unzoomed
    // content width and height
    // example point: { "x": 0, "y": 0 } // makes the top-left corner of the content
    // the centre of the view

    let target: PanZoomModel = {
      pan: {
        x: ( (this.frameWidth / 2) ) - point.x * this.scale,
        y: ( (this.frameHeight / 2) ) - point.y * this.scale
      },
      zoomLevel: this.base.zoomLevel
    };

    this.animateToTarget(target, duration);
  }



  private panDelta(delta: Point, duration: number = null) {
    // console.log('PanZoomComponent: panDelta(): delta:', delta);

    // API call to pan the view left, right, up, or down, based on a number of pixels
    // of the original, unzoomed content.
    // Positive is right and down
    // Negative is left and up
    // example point: { "x": 100, "y": -50 } // moves the view right 50px and up 50px

    let target: PanZoomModel = {
      pan: {
        x: this.base.pan.x - this.scale * delta.x,
        y: this.base.pan.y - this.scale * delta.y
      },
      zoomLevel: this.base.zoomLevel
    };
    this.animateToTarget(target, duration);
  }



  private panDeltaAbsolute(delta: Point, duration: number = null) {
    // console.log('PanZoomComponent: panDeltaAbsolute(): delta:', delta);

    // API call to pan the view left, right, up, or down, based on a number of pixels
    // This method doesn't adjust for scale.  I'm not sure why you'd want this
    // but have it here just in case someone needs it
    // Positive is right and down
    // Negative is left and up
    // example point: { "x": 100, "y": -50 } // moves the view right 50px and up 50px

    let target: PanZoomModel = {
      pan: {
        x: this.base.pan.x - delta.x,
        y: this.base.pan.y - delta.y
      },
      zoomLevel: this.base.zoomLevel
    };
    this.animateToTarget(target, duration);
  }



  private panDeltaPercent(deltaPercent: Point, duration: number = null) {
    // console.log('PanZoomComponent: panDeltaPercent(): deltaPercent:', deltaPercent);

    // API call to pan the view up, down, left, or right, based on a percentage
    // of the original, unzoomed content width and height
    // example point: { "x": 10, "y": -20 }

    let deltaX = 0;
    let deltaY = 0;
    if (deltaPercent.x !== 0) {
      deltaX = this.contentWidth * ( deltaPercent.x / 100 ) * this.scale;
    }
    if (deltaPercent.y !== 0) {
      deltaY = this.contentHeight * ( deltaPercent.y / 100 ) * this.scale;
    }

    let target: PanZoomModel = {
      pan: {
        x: this.base.pan.x - deltaX,
        y: this.base.pan.y - deltaY
      },
      zoomLevel: this.base.zoomLevel
    };
    // target.pan.x is the panElement left style property
    // target.pan.y is the panElement top style property
    this.animateToTarget(target, duration);
  }







  ////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////// ANIMATION BUILDERS ///////////////////////////////
  ////////////////////////////////////////////////////////////////////////////////



  private animateToTarget(targetModel: PanZoomModel, duration = null) {
    // console.log('PanZoomComponent: animateToTarget()');
    // what this function really does is take a target model, and then sets
    // this.animationParams with the parameters for the whole animation,
    // namely the delta zoomLevel
    // it is the responsibility of the caller to kick off the animation with a call to animationFrameFunc()

    if (this.animationParams) {
      // make the user wait for existing animation to finish before clicking
      return;
    }

    this.zoomLevelIsChanging = false;
    if (this.base.zoomLevel !== targetModel.zoomLevel) {
      this.zoomLevelIsChanging = true;
    }

    let deltaZoomLevel = targetModel.zoomLevel - this.base.zoomLevel; // deltaZoomLevel is the number of zoom levels we are changing here

    let oldBase: Point = {
      // the current base coordinates
      x: this.base.pan.x,
      y: this.base.pan.y
    };
    this.model.pan.x = this.base.pan.x;
    this.model.pan.y = this.base.pan.y;
    /*this.lastClickPoint = {
      x: this.base.pan.x,
      y: this.base.pan.y
    };*/

    let panStepFunc = (zoomLevel: number) => {
      // this function gets called during every animation tick in updateDOM(), to calculate where to move the model pan coordinates to (i.e. the translation) for that tick, zoomLevel is ignored within animateToTarget()
      let targetPoint: Point = {
        // The target point to zoom to for the current animation frame.  It must stay the same as the untranslated point
        x: (oldBase.x - targetModel.pan.x) * this.animationParams.progress,
        y: (oldBase.y - targetModel.pan.y) * this.animationParams.progress
      };

      return { x: -targetPoint.x, y: -targetPoint.y };
    };

    // now set the parameters of our new animation
    if (duration) {
      duration = duration * 1000;
    }
    else {
      duration = this.config.zoomStepDuration * 1000;
    }
    this.animationParams = {
      deltaZoomLevel: deltaZoomLevel, // how many zooom levels to zoom in or out
      panStepFunc: panStepFunc, // a function which runs on every animation tick, which calcs how much to pan the view on every frame
      // duration: duration || this.config.zoomStepDuration, // how long the animation should take
      duration: duration, // how long the animation should take
      progress: 0.0
    };

    this.startAnimation();

  }



  private changeZoomLevel(newZoomLevel: number, clickPoint: Point, duration = this.config.zoomStepDuration) {
    console.log('PanZoomComponent: changeZoomLevel()');

    if (this.animationParams) {
      // let's let any current animation just finish
      return;
    }

    this.zoomLevelIsChanging = true;

    // keep zoom level in bounds
    // newZoomLevel = Math.max(this.minimumAllowedZoomLevel, newZoomLevel);
    // newZoomLevel = Math.min(this.config.zoomLevels - 1, newZoomLevel);
    console.log('newZoomLevel:', newZoomLevel);

    let deltaZoomLevel = newZoomLevel - this.base.zoomLevel; // deltaZoomLevel is the number of zoom levels we are changing here
    console.log('deltaZoomLevel:', deltaZoomLevel);
    if (!deltaZoomLevel) {
      // a deltaZoomLevel of zero means that we aren't changing zoom, because we're either zoomed all the way in or all the way out
      return;
    }

    //
    // Let p be the vector to the clicked point in view coords and let p' be the same point in model coords. Let s be a scale factor
    // and let t be a translation vector. Let the transformation be defined as:
    //
    //  p' = p * s + t
    //
    // And conversely:
    //
    //  p = (1/s)(p' - t)
    //
    // Now use subscription 0 to denote the value before transform and zoom and let 1 denote the value after transform. Scale
    // changes from s0 to s1. Translation changes from t0 to t1. But keep p and p' fixed so that the view coordinate p' still
    // corresponds to the model coordinate p. This can be expressed as an equation relying upon solely upon p', s0, s1, t0, and t1:
    //
    //  (1/s0)(p - t0) = (1/s1)(p - t1)
    //
    // Every variable but t1 is known, thus it is easily isolated to:
    //
    //  t1 = p' - (s1/s0)*(p' - t0)
    //

    let currentPan: Point = {
      // t0 - the current base coordinates
      x: this.base.pan.x,
      y: this.base.pan.y
    };

    let currentScale = this.scale; // s0 - get the current CSS scale (scale0)
    let destPoint = clickPoint || this.getCenterPoint(); // pmark - the point we are aiming to zoom to (either the click point or the centre of the page)


    let panStepFunc = (zoomLevel: number) => {
      // this function gets called during every animation tick, to calculate where to move the model pan coordinates to (i.e. the translation) for that tick, where zoomLevel is calculated from the current zoomLevel + the target zoomLevel * the progress of the current animation

      let targetScale = this.getCssScale(zoomLevel); // s1 - the scale to translate to for the current animation tick
      let targetPoint: Point = {
        // t1 - The target point to pan to.  It must stay the same as the untranslated point
        x: destPoint.x - (targetScale / currentScale) * (destPoint.x - currentPan.x),
        y: destPoint.y - (targetScale / currentScale) * (destPoint.y - currentPan.y)
      };

      return {
        // now return the difference between our initial click point and our translated (zoomed) click point
        // these are not absolute coordinates - just how far to move them
        x: targetPoint.x - currentPan.x,
        y: targetPoint.y - currentPan.y
      };
    };

    // now set the parameters of our new animation
    this.animationParams = {
      deltaZoomLevel: deltaZoomLevel, // the destination zoom level for this zoom operation (when the animation is completed)
      panStepFunc: panStepFunc,
      // duration: this.config.zoomStepDuration, // how long the animation should take
      duration: duration * 1000, // how long the animation should take
      progress: 0.0
    };
    this.startAnimation();

  }



}
