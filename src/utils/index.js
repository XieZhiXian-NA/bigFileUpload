const baseUrl = 'http://localhost:3000'
export function request({
    url,
    method="post",
    data,
    onProgress = e=>e,
    headers={},
    requestList
}){
    return new Promise((resolve,reject)=>{
        const xhr = new XMLHttpRequest()
        xhr.upload.onprogress = onProgress
        xhr.open(method,baseUrl+url)
        Object.keys(headers).forEach(key=>xhr.setRequestHeader(key,headers[key]))
        xhr.send(data)
        xhr.onreadystatechange = e=>{
            if(xhr.readyState === 4){
                if(xhr.status === 200){
                    if(requestList){
                        const i = requestList.findIndex(req=>req===xhr)
                        requestList.splice(i,1)
                    }
                    resolve({data:e.target.response})
                }else if(xhr.status === 500){
                    reject('报错了 大哥')
                }
            }
        }
        //将所有的请求都放在一个数组里，当完成一个请求时，删除对应的列表里的请求
        // 方便做请求的暂停与重新开始
        requestList?.push(xhr)
    })
}
export async function post(url,data){
    let ret = await request({url,data:JSON.stringify(data),headers:{"content-type": "application/json"}})
    return JSON.parse(ret.data)
}