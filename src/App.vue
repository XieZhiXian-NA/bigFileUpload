<template>
  <div id="app">
    <div>
      <input type="text" value="测试页面是否卡顿" />
    </div>
    <h1>测试</h1>
    <input type="file" @change="handleFileChange" />
    <el-button type="primary" @click="handleUpload">上传</el-button>
    <el-button @click="handleResume" v-if="status === Status.pause">恢复</el-button>
    <el-button
      @click="handlePause"
      v-else
      :disabled="status !== Status.uploading || !container.hash"
    >暂停</el-button>
    <div>计算文件 hash</div>
    <el-progress :percentage="hashProgress"></el-progress>
    <div>总进度</div>
    <el-progress :percentage="fakeProgress"></el-progress>

    <div class="cube-container" :style="{width:cubeWidth+'px'}">
      <div class="cube" v-for="chunk in chunks" :key="chunk.hash">
         <div
          :class="{
            'uploading':chunk.progress>0 && chunk.progress<100,
            'success':chunk.progress==100,
            'error':chunk.progress<0
          }"
          :style="{height:chunk.progress+'%'}"
         >
          {{chunk.index}}
          <i class="el-icon-loading loading" v-if="chunk.progress>0 && chunk.progress<100" style="color:#F56C6C;"></i>
         </div>
      </div>
    </div>
  </div>
</template>

<script>
import HelloWorld from './components/HelloWorld.vue'
import SparkMD5 from 'spark-md5'
import { request, post } from './utils'
const SIZE = 0.2 * 1024 * 1024;
const Status = {
  wait: "wait",
  pause: "pause",
  uploading: "uploading",
  error: "error",
  done: "done",
};
export default {
  name: 'app',
  data(){
    return {
      container:{
        file:null
      },
      chunks:[],
      hashProgress:0,
      Status,
       requestList: [],
       status:Status.wait,
       fakeProgress: 0,
    }
  },
  components: {
    HelloWorld
  },
  computed:{
     uploadedProgress(){
       if(!this.container.file || !this.chunks.length)  return 0
       const loaded = this.chunks
                      .map(item=>item.size*item.progress)
                      .reduce((acc,cur)=>acc+cur)
       return parseInt((loaded/this.container.file.size).toFixed(2))
     },
     cubeWidth(){
       return Math.ceil(Math.sqrt(this.chunks.length))*16
     }
  },
  watch:{
    uploadedProgress(now){
      if(now>this.fakeProgress) this.fakeProgress = now
    }
  },
  methods:{
    async handleResume() {
      this.status = Status.uploading;

      const { uploadedList } = await this.verify(
        this.container.file.name,
        this.container.hash
      );
      await this.uploadChunks(uploadedList);
    },
    handlePause() {
      this.status = Status.pause;

      this.requestList.forEach(xhr => xhr?.abort());
      this.requestList = [];
    },
    handleFileChange(e) {
      const [file] = e.target.files;
      if (!file) return;
      this.container.file = file;
    },
    createFileChunk(file, size = SIZE) {
      // 生成文件块
      const chunks = [];
      let cur = 0;
      while (cur < file.size) {
        chunks.push({ file: file.slice(cur, cur + size) });
        cur += size;
      }
      return chunks;
    },

    async sendRequest(urls, max=4,retrys=3) {
      console.log(urls,max)

      return new Promise((resolve,reject) => {
        const len = urls.length;
        let idx = 0;
        let counter = 0;
        const retryArr = []
        const start = async ()=> {
          // 有请求，有通道
          while (counter < len && max > 0) {
            max--; // 占用通道
            console.log(idx, "start");
            const i = urls.findIndex(v=>v.status==Status.wait || v.status==Status.error )// 等待或者error
            urls[i].status = Status.uploading
            const form = urls[i].form;
            const index = urls[i].index;
            console.log(retryArr)
            if(typeof retryArr[index]=='number'){
              console.log(index,'开始重试')
            }
            request({
              url: '/upload',
              data: form,
              onProgress: this.createProgresshandler(this.chunks[index]),
              requestList: this.requestList
            }).then(() => {
               urls[i].status = Status.done

              max++; // 释放通道

              counter++;
              urls[counter].done=true
              if (counter === len) {
                resolve();
              } else {
                start();
              }
            }).catch(()=>{
                // 初始值
               urls[i].status = Status.error
               if(typeof retryArr[index]!=='number'){
                  retryArr[index] = 0
               }
              // 次数累加
              retryArr[index]++
              // 一个请求报错3次的
              if(retryArr[index]>=2){
                return reject() // 考虑abort所有别的
              }
              console.log(index, retryArr[index],'次报错')
              // 3次报错以内的 重启
              this.chunks[index].progress = -1 // 报错的进度条
              max++; // 释放当前占用的通道，但是counter不累加

              start()
            })
          }
        }
        start();
      });
    },

    async uploadChunks(uploadedList = []) {
      // 这里一起上传，碰见大文件就是灾难
      // 没被hash计算打到，被一次性的tcp链接把浏览器稿挂了
      // 异步并发控制策略
      // 比如并发量控制成4
      const list = this.chunks
        .filter(chunk => uploadedList.indexOf(chunk.hash) == -1)
        .map(({ chunk, hash, index }, i) => {
          const form = new FormData();
          form.append("chunk", chunk);
          form.append("hash", hash);
          form.append("filename", this.container.file.name);
          form.append("fileHash", this.container.hash);
          return { form, index,status:Status.wait };
        })
        // .map(({ form, index }) =>
        //   request({
        //     url: "/upload",
        //     data: form,
        //     onProgress: this.createProgresshandler(this.chunks[index]),
        //     requestList: this.requestList
        //   })
        // );
      // await Promise.all(list);
      try{
        const ret =  await this.sendRequest(list,4)
        if (uploadedList.length + list.length === this.chunks.length) {
          // 上传和已经存在之和 等于全部的再合并
          await this.mergeRequest();
        }
      }catch(e){
        // 上传有被reject的
         this.$message.error('亲 上传失败了,考虑重试下呦');

      }

    },
    createProgresshandler(item) {
      return e => {
        item.progress = parseInt(String((e.loaded / e.total) * 100));
      };
    },

    async mergeRequest() {
      await post("/merge", {
        filename: this.container.file.name,
        size: SIZE,
        fileHash: this.container.hash
      });
      // await request({
      //   url: "/merge",
      //   headers: {
      //     "content-type": "application/json"
      //   },
      //   data: JSON.stringify({
      //     filename: this.container.file.name,
      //     size:SIZE
      //   })
      // })
    },
    async calculateHashWebWork(chunks) {
      return new Promise(resolve => {
        // web-worker 防止卡顿主线程
        this.container.workder = new Worker("/webwork.js");
        this.container.workder.postMessage({ chunks });
        this.container.workder.onmessage = e => {
          const { progress, hash } = e.data;
          this.hashProgress = Number(progress.toFixed(2));
          if (hash) {
            resolve(hash);
          }
        };
      });
    },
    async calculateHashSample() {
      return new Promise(resolve => {
        const spark = new SparkMD5.ArrayBuffer();
        const reader = new FileReader();
        const file = this.container.file;
        // 文件大小
        const size = this.container.file.size;
        let offset = 2 * 1024 * 1024;

        let chunks = [file.slice(0, offset)];

        // 前面100K

        let cur = offset;
        while (cur < size) {
          // 最后一块全部加进来
          if (cur + offset >= size) {
            chunks.push(file.slice(cur, cur + offset));
          } else {
            // 中间的 前中后去两个子杰
            const mid = cur + offset / 2;
            const end = cur + offset;
            chunks.push(file.slice(cur, cur + 2));
            chunks.push(file.slice(mid, mid + 2));
            chunks.push(file.slice(end - 2, end));
          }
          // 前取两个子杰
          cur += offset;
        }
        // 拼接
        reader.readAsArrayBuffer(new Blob(chunks));

        // 最后100K
        reader.onload = e => {
          spark.append(e.target.result);

          resolve(spark.end());
        };
      });
    },
    async calculateHashIdle(chunks) {
      return new Promise(resolve => {
        const spark = new SparkMD5.ArrayBuffer();
        let count = 0;
        const appendToSpark = async file => {
          return new Promise(resolve => {
            const reader = new FileReader();
            reader.readAsArrayBuffer(file);
            reader.onload = e => {
              spark.append(e.target.result);
              resolve();
            };
          });
        };
        const workLoop = async deadline => {
          // 有任务，并且当前帧还没结束
          while (count < chunks.length && deadline.timeRemaining() > 1) {
            await appendToSpark(chunks[count].file);
            count++;
            // 没有了 计算完毕
            if (count < chunks.length) {
              // 计算中
              this.hashProgress = Number(
                ((100 * count) / chunks.length).toFixed(2)
              );
              // console.log(this.hashProgress)
            } else {
              // 计算完毕
              this.hashProgress = 100;
              resolve(spark.end());
            }
          }
          window.requestIdleCallback(workLoop);
        };
        window.requestIdleCallback(workLoop);
      });
    },
    async verify(filename, hash) {
      const data = await post("/verify", { filename, hash });
      return data;
    },
    async handleUpload1(){
      // @todo数据缩放的比率 可以更平缓
      // @todo 并发+慢启动

      // 慢启动上传逻辑
      const file = this.container.file
      if (!file) return;
      this.status = Status.uploading;
      const fileSize = file.size
      let offset = 1024*1024
      let cur = 0
      let count =0
      this.container.hash = await this.calculateHashSample();

      while(cur<fileSize){
        const chunk = file.slice(cur, cur+offset)
        cur+=offset
        const chunkName = this.container.hash + "-" + count;
        const form = new FormData();
        form.append("chunk", chunk);
        form.append("hash", chunkName);
        form.append("filename", file.name);
        form.append("fileHash", this.container.hash);
        form.append("size", chunk.size);

        let start = new Date().getTime()
        await request({ url: '/upload',data: form })
        const now = new Date().getTime()

        const time = ((now -start)/1000).toFixed(4)
        let rate = time/30
        // 速率有最大和最小 可以考虑更平滑的过滤 比如1/tan
        if(rate<0.5) rate=0.5
        if(rate>2) rate=2
        // 新的切片大小等比变化
        console.log(`切片${count}大小是${this.format(offset)},耗时${time}秒，是30秒的${rate}倍，修正大小为${this.format(offset/rate)}`)
        offset = parseInt(offset/rate)
        // if(time)
        count++
      }



    },
    format(num){
      if(num>1024*1024*1024){
        return (num/(1024*1024*1024)).toFixed(2)+'GB'
      }
      if(num>1024*1024){
        return (num/(1024*1024)).toFixed(2)+'MB'
      }
      if(num>1024){
        return (num/(1024)).toFixed(2)+'KB'
      }
      return num+'B'
    },
    async handleUpload() {
      if (!this.container.file) return;
      this.status = Status.uploading;
      const chunks = this.createFileChunk(this.container.file);
      console.log(chunks);
      // 计算哈希
      // this.container.hash = await this.calculateHashSync(chunks)
      console.time("samplehash");
      // 这样抽样，大概1个G1秒，如果还嫌慢，可以考虑分片+web-worker的方式
      // 这种方式偶尔会误判 不过大题效率不错
      // 可以考虑和全部的hash配合，因为samplehash不存在，就一定不存在，存在才有可能误判，有点像布隆过滤器
      this.container.hash = await this.calculateHashSample();
      console.timeEnd("samplehash");

      console.log("hashSample", this.container.hash);

      // this.container.hash = await this.calculateHashIdle(chunks);
      // console.log("hash2", this.container.hash);

      // this.container.hash = await this.calculateHash(chunks);
      // console.log("hash3", this.container.hash);

      // 判断文件是否存在,如果不存在，获取已经上传的切片
      const { uploaded, uploadedList } = await this.verify(
        this.container.file.name,
        this.container.hash
      );

      if (uploaded) {
        return this.$message.success("秒传:上传成功");
      }
      this.chunks = chunks.map((chunk, index) => {
        const chunkName = this.container.hash + "-" + index;
        return {
          fileHash: this.container.hash,
          chunk: chunk.file,
          index,
          hash: chunkName,
          progress: uploadedList.indexOf(chunkName) > -1 ? 100 : 0,
          size: chunk.file.size
        };
      });
      // 传入已经存在的切片清单
      await this.uploadChunks(uploadedList);
    
  }
  }
}
</script>

<style>
#app {
  font-family: "Avenir", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
  margin-top: 60px;
}
.cube-container{
   width: 150px;
   overflow: hidden;
   margin: 0 auto;
}
.cube{
  width: 20px;
  height: 20px;
  line-height: 16px;
  border: 1px solid black;
  background: #eee;
  position: relative;
  float: left;
}
.success {background: #67c23a}
.uploading {background:#409EFF}
.error { background: #F56C6C}
.loading
  {
    position :absolute;
    top :10%;
    left :20%;
  }

</style>
