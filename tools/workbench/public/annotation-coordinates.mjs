/** All coordinates are CSS pixels in the surface, or oriented work-image pixels. */
export function imageToView(xy,{rect,workWidth,workHeight,zoom=1,pan={x:0,y:0}}){
 return {x:rect.x+rect.width*(1-zoom)/2+pan.x+xy[0]*rect.width/workWidth*zoom,
  y:rect.y+rect.height*(1-zoom)/2+pan.y+xy[1]*rect.height/workHeight*zoom};
}
export function viewToImage(point,transform){
 const {rect,workWidth,workHeight,zoom=1}=transform;
 if(!(rect.width>0&&rect.height>0&&workWidth>0&&workHeight>0&&zoom>0))return null;
 const origin=imageToView([0,0],transform),x=(point.x-origin.x)*workWidth/(rect.width*zoom),y=(point.y-origin.y)*workHeight/(rect.height*zoom);
 return x>=0&&y>=0&&x<workWidth&&y<workHeight?[x,y]:null;
}
