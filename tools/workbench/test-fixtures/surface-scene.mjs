// A dense opaque red plane, independent of user photos and reconstruction data.
export function surfacePly() {
  const properties=['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
  const count=21*21, data=Buffer.alloc(count*properties.length*4);
  let offset=0;
  for(let y=-10;y<=10;y++)for(let x=-10;x<=10;x++){
    const values=[x*.02,y*.02,0,(.95-.5)/.2820947918,(.02-.5)/.2820947918,(.02-.5)/.2820947918,
      Math.log(.99/.01),Math.log(.012),Math.log(.012),Math.log(.0003),1,0,0,0];
    for(const value of values){data.writeFloatLE(value,offset);offset+=4;}
  }
  const header=`ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n${properties.map(name=>`property float ${name}\n`).join('')}end_header\n`;
  return Buffer.concat([Buffer.from(header),data]);
}
